/**
 * codex 的模型测速（真回合探针）。
 *
 * 为什么要有这一层测试：测速是**唯一会替用户花钱**的功能，错在这里的代价不是「界面上难看一点」，
 * 而是「点一下又跑一轮」。所以这里用假 client 把时序钉死：
 *   - 首字节 / 收尾的时刻 → TTFT 与出字速度；
 *   - 探针 thread **必须**被删掉（不然 codex 的历史里会多出一条 `ping`）；
 *   - 模型不在 model/list 里时**一次回合都不发**。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCodexEngine, probeMetrics } from "../../server/engine/codex.ts";
import type { CodexClient } from "../../server/engine/codex-transport.js";

type Frame = { method: string; params: Record<string, unknown> };

/**
 * 假 app-server：只认测速用到的那几个方法。
 * `beforeComplete` 让我们在 turn/start 之后、turn/completed 之前插通知（模拟流式出字）。
 */
function fakeClient(options: {
	catalog?: { id: string; model: string }[];
	onTurnStart?: (emit: (method: string, params: Record<string, unknown>) => void) => void;
}): { client: CodexClient; calls: Frame[] } {
	const calls: Frame[] = [];
	let listener: ((notification: { method: string; params: Record<string, unknown> }) => void) | null = null;
	let currentThread = "";
	// codex 的每条通知都带 threadId（引擎靠它把事件分派到会话 / 探针）
	const emit = (method: string, params: Record<string, unknown>) =>
		listener?.({ method, params: { threadId: currentThread, ...params } });
	let probes = 0;
	const client = {
		async request(method: string, params: Record<string, unknown> = {}) {
			calls.push({ method, params });
			switch (method) {
				case "model/list":
					return { data: options.catalog ?? [{ id: "m1", model: "gpt-5-probe" }] };
				case "thread/start":
					probes += 1;
					currentThread = `thread-${probes}`;
					return { thread: { id: currentThread } };
				case "turn/start": {
					// turn/start 之后异步推流：先一个增量，再 usage，最后 turn/completed
					setTimeout(() => {
						options.onTurnStart?.((methodName, params2) => emit(methodName, params2));
						emit("turn/completed", { turn: { status: "completed" } });
					}, 0);
					return { turn: { id: "turn-1" } };
				}
				default:
					return {};
			}
		},
		onNotification(fn: (notification: { method: string; params: Record<string, unknown> }) => void) {
			listener = fn;
			return () => {
				listener = null;
			};
		},
		onServerRequest: () => () => {},
		respond: () => {},
		respondError: () => {},
		notify: () => {},
		ensureStarted: async () => {},
		isReady: () => true,
		version: () => "0.163.0",
		onExit: () => () => {},
		close: () => {},
	};
	return { client: client as unknown as CodexClient, calls };
}

test("测速：首字节 + 出字速度，且探针 thread 会被删掉", async () => {
	const { client, calls } = fakeClient({
		onTurnStart: (emit) => {
			// 首字节
			emit("item/agentMessage/delta", { delta: "pong" });
			// 输出 token（codex 只给 last 桶）
			emit("thread/tokenUsage/updated", { tokenUsage: { last: { outputTokens: 8 } } });
		},
	});
	const engine = createCodexEngine({ client });
	const result = await engine.probeModel("gpt-5-probe");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(typeof result.totalMs, "number");
	assert.ok(result.totalMs >= 0);
	// 假 client 是同一 tick 出字，所以 TTFT 只可能「有值且很小」，不会是 null
	assert.ok(result.ttftMs !== null);
	assert.equal(result.outputTokens, 8);
	// 假 client 同一 tick 内出字：生成窗口只有几毫秒，所以不给「生成速度」，只给端到端均速
	assert.equal(result.tps, null);
	assert.ok(result.averageTps !== null && result.averageTps > 0);

	const methods = calls.map((call) => call.method);
	assert.deepEqual(methods.slice(0, 4), ["model/list", "thread/start", "thread/settings/update", "turn/start"]);
	// 收尾必须删 thread（否则 codex 历史里会留下一条 ping）
	assert.ok(methods.includes("thread/delete"));
	assert.equal(calls.find((call) => call.method === "thread/settings/update")?.params.model, "gpt-5-probe");
});

test("测速：模型不在 model/list 里 → 不发回合，直接给可读错误", async () => {
	const { client, calls } = fakeClient({ catalog: [{ id: "m1", model: "gpt-5" }] });
	const engine = createCodexEngine({ client });
	const result = await engine.probeModel("不存在的模型");
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /没有这个模型/);
	assert.ok(!calls.some((call) => call.method === "turn/start"), "不该为一个不存在的模型烧一次真实回合");
});

test("测速：turn/completed 报 failed → 失败结果（而不是一个 0 token 的「成功」）", async () => {
	const { client } = fakeClient({
		onTurnStart: (emit) => {
			emit("turn/completed", { turn: { status: "failed" } });
		},
	});
	const engine = createCodexEngine({ client });
	const result = await engine.probeModel("gpt-5-probe");
	assert.equal(result.ok, false);
});

test("测速：瞬时重试（willRetry）不算失败", async () => {
	const { client } = fakeClient({
		onTurnStart: (emit) => {
			emit("error", { willRetry: true, error: { message: "429 too many requests" } });
			emit("item/agentMessage/delta", { delta: "pong" });
			emit("thread/tokenUsage/updated", { tokenUsage: { last: { outputTokens: 2 } } });
		},
	});
	const engine = createCodexEngine({ client });
	const result = await engine.probeModel("gpt-5-probe");
	assert.equal(result.ok, true);
});

test("probeMetrics：没等到首字节时 ttftMs=null，均速按总耗时算", () => {
	const result = probeMetrics({ startedAt: 1000, firstAt: null, outputTokens: 10 }, 3000);
	// 没看到首字节时「生成窗口」就等于整轮，所以两个速度是一致的
	assert.deepEqual(result, { ok: true, ttftMs: null, totalMs: 2000, outputTokens: 10, tps: 5, averageTps: 5 });
});

test("probeMetrics：输出太少（<5 token）不给任何速度，别把噪声装成结论", () => {
	const result = probeMetrics({ startedAt: 0, firstAt: 1000, outputTokens: 3 }, 1040);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.tps, null);
	assert.equal(result.averageTps, null);
	assert.equal(result.outputTokens, 3);
});

test("probeMetrics：生成窗口够长时，生成速度只算「首字之后」", () => {
	// 首字节花了 3s，之后 4s 出了 20 token → TTFT 3000ms，生成 5 tok/s（而不是 20/7s）
	const result = probeMetrics({ startedAt: 0, firstAt: 3000, outputTokens: 20 }, 7000);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.ttftMs, 3000);
	assert.equal(result.totalMs, 7000);
	assert.equal(result.tps, 5);
	// 端到端均速把首字延迟算进去：20/7s ≈ 2.9 tok/s
	assert.equal(result.averageTps, 2.9);
});

test("probeMetrics：窗口太短（delta 攒包）不报生成速度，只给端到端均速", () => {
	// 实测踩过的数字：40 token / 145ms 的生成窗口，会算出 276 tok/s
	const result = probeMetrics({ startedAt: 0, firstAt: 2063, outputTokens: 40 }, 2208);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.tps, null);
	assert.equal(result.averageTps, 18.1);
});

test("probeMetrics：拿不到 output token 时速度给 null（不编数字）", () => {
	const result = probeMetrics({ startedAt: 0, firstAt: 100, outputTokens: 0 }, 900);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.tps, null);
	assert.equal(result.averageTps, null);
});
