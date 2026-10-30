/**
 * 「每个会话各算各的」——模型 / 思考档位 / 提示条。
 *
 * 用户报的两个现象：
 *   1. 在窗口 A 给某个会话换了模型，窗口 B 看**另一个会话**也跟着变了；
 *   2. 一个会话报的错，在别的会话 / 别的窗口的提示条上也冒出来（还挂着不走）。
 *
 * 根因都是「该按会话存的东西存在了全局一份」：
 *   - `state.modelByConversation` / `state.thinkingByConversation` **从来没被写入过**，
 *     快照里的 `pickPerConversation` 永远回落到全局的 `state.model`；
 *   - `state.notices` 是全局一份，且事件广播给所有客户端。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnginePort } from "../../server/engine/port.ts";
import { createModelController } from "../../server/session/model-controller.ts";
import { createNoticeSink } from "../../server/session/notices.ts";
import { buildSnapshot, createServerState } from "../../server/snapshot/state.ts";

/** 最小可用的引擎桩：只实现这个测试关心的三个方法 */
function stubEngine(options: {
	current?: Record<string, string | null>;
	levels?: Record<string, string | null>;
}): EnginePort {
	return {
		listModels: async (sessionId?: string) => {
			const current = sessionId ? (options.current?.[sessionId] ?? null) : null;
			return [
				{ id: "p/a", label: "A", current: current === "p/a" },
				{ id: "p/b", label: "B", current: current === "p/b" },
			];
		},
		switchModel: async () => true,
		listThinkingLevels: async () => ["low", "high"],
		getThinkingLevel: async (sessionId?: string) => (sessionId ? (options.levels?.[sessionId] ?? null) : null),
		setThinkingLevel: async () => true,
	} as unknown as EnginePort;
}

const makeController = (state: ReturnType<typeof createServerState>, engine: EnginePort) =>
	createModelController({ engine, state, notice: () => {}, onChanged: () => {} });

describe("模型按会话各算各的", () => {
	it("switchTo 只改这个会话（另一个会话的模型不变）", async () => {
		const state = createServerState("/w");
		state.model = "p/a";
		state.modelByConversation["conv-b"] = "p/a";
		const controller = makeController(state, stubEngine({}));

		assert.deepEqual(await controller.switchTo("conv-a", "p/b"), { ok: true });

		// A 换成 B，B 会话仍然是 A
		assert.equal(buildSnapshot(state, 100, "conv-a").model, "p/b");
		assert.equal(buildSnapshot(state, 100, "conv-b").model, "p/a");
	});

	it("refresh 把引擎报的「这个会话现在用哪个」落到该会话名下", async () => {
		const state = createServerState("/w");
		const engine = stubEngine({ current: { "conv-a": "p/b", "conv-b": "p/a" } });
		const controller = makeController(state, engine);

		await controller.refresh("conv-a");
		await controller.refresh("conv-b");

		assert.equal(state.modelByConversation["conv-a"], "p/b");
		assert.equal(state.modelByConversation["conv-b"], "p/a");
		assert.equal(buildSnapshot(state, 100, "conv-a").model, "p/b");
		assert.equal(buildSnapshot(state, 100, "conv-b").model, "p/a");
	});

	it("没有该会话的记录时才回落到全局（新会话的起点）", () => {
		const state = createServerState("/w");
		state.model = "p/a";
		assert.equal(buildSnapshot(state, 100, "conv-new").model, "p/a");
		assert.equal(buildSnapshot(state, 100, null).model, "p/a");
	});

	it("还没开会话时也能选模型：改写「新会话的起点」，不再报「先打开一个会话」", async () => {
		// dsh / opencode / claude 切过来、空状态下模型下拉是可以点的 —— 以前点一下报错
		const state = createServerState("/w");
		state.models = [
			{ id: "p/a", label: "A" },
			{ id: "p/b", label: "B" },
		];
		let changed = 0;
		const controller = createModelController({
			engine: stubEngine({}),
			state,
			notice: () => {},
			onChanged: () => {
				changed += 1;
			},
		});

		assert.deepEqual(await controller.switchTo(null, "p/b"), { ok: true });
		assert.equal(state.model, "p/b"); // 新会话就从这个模型起头（conversation-create 读它）
		assert.equal(buildSnapshot(state, 100, null).model, "p/b");
		assert.equal(changed, 1);

		// 不在当前引擎列表里的（引擎刚切过、列表还没到）不能静默写进去
		assert.equal((await controller.switchTo(null, "p/zzz")).ok, false);
		assert.equal(state.model, "p/b");
	});
});

describe("思考档位按会话各算各的", () => {
	it("setThinking 只改这个会话", async () => {
		const state = createServerState("/w");
		state.thinkingByConversation["conv-b"] = "low";
		const controller = makeController(state, stubEngine({}));

		assert.deepEqual(await controller.setThinking("conv-a", "high"), { ok: true });

		assert.equal(buildSnapshot(state, 100, "conv-a").thinkingLevel, "high");
		assert.equal(buildSnapshot(state, 100, "conv-b").thinkingLevel, "low");
	});

	it("refreshThinking 读到的是这个会话自己的档位", async () => {
		const state = createServerState("/w");
		const controller = makeController(state, stubEngine({ levels: { "conv-a": "high", "conv-b": "low" } }));

		await controller.refreshThinking("conv-a");
		await controller.refreshThinking("conv-b");

		assert.equal(buildSnapshot(state, 100, "conv-a").thinkingLevel, "high");
		assert.equal(buildSnapshot(state, 100, "conv-b").thinkingLevel, "low");
	});
});

describe("提示条按会话归属", () => {
	const makeSink = (onNotice: (notice: unknown) => void) =>
		createNoticeSink({ now: () => 1000, nextId: (prefix) => `${prefix}-1`, onNotice });

	it("带会话 id 的提示会把它记下来（界面据此只显示当前会话的）", () => {
		const pushed: Array<{ text: string; conversationId?: string }> = [];
		const sink = makeSink((notice) => pushed.push(notice as { text: string; conversationId?: string }));
		sink.push("engine.provider_error: boom", "error", undefined, "conv-a");
		assert.equal(pushed[0]?.conversationId, "conv-a");
	});

	it("两个会话同一秒报同一句话 → 两条（去重键带上会话，不能互相吞掉）", () => {
		const pushed: unknown[] = [];
		const sink = makeSink((notice) => pushed.push(notice));
		sink.push("engine.provider_error: boom", "error", undefined, "conv-a");
		sink.push("engine.provider_error: boom", "error", undefined, "conv-b");
		assert.equal(pushed.length, 2);
	});

	it("同一个会话重复同一句话仍然去重（窗口内只推一次）", () => {
		const pushed: unknown[] = [];
		const sink = makeSink((notice) => pushed.push(notice));
		sink.push("boom", "error", undefined, "conv-a");
		sink.push("boom", "error", undefined, "conv-a");
		assert.equal(pushed.length, 1);
	});

	it("全局提示（不带会话）不会被当成某个会话的", () => {
		const pushed: Array<{ conversationId?: string }> = [];
		const sink = makeSink((notice) => pushed.push(notice as { conversationId?: string }));
		sink.push("连接已断开", "warn");
		assert.equal(pushed[0]?.conversationId, undefined);
	});
});

describe("「正在重试」按会话归位", () => {
	it("只在「正在跑的那条会话」的快照里出现，别人的是 null", () => {
		const state = createServerState("/w");
		state.activeId = "conv-a";
		state.running = {
			status: "streaming",
			conversationId: "conv-a",
			turnStartedAt: Date.now(),
			streamingText: "",
			activeTool: null,
			retrying: { attempt: 1, maxAttempts: 2 },
		};
		assert.deepEqual(buildSnapshot(state, 100, "conv-a").running.retrying, { attempt: 1, maxAttempts: 2 });
		// 切到另一个会话看：那是别人的回合，不该跟着显示「正在重试」
		assert.equal(buildSnapshot(state, 100, "conv-b").running.retrying, null);
	});

	it("空转态默认就是 null（不会瞎显示）", () => {
		const state = createServerState("/w");
		assert.equal(buildSnapshot(state, 100, state.activeId).running.retrying, null);
	});
});
