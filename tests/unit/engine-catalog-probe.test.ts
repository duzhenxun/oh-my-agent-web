/**
 * 三个 ACP 引擎（dsh / opencode / claude）的**模型目录探针**。
 *
 * 为什么值得单独测：这三个引擎的模型表只在 `session/new` 的返回里（opencode / dsh 是
 * `configOptions`，claude 是 `models`），于是「切过来但还没开会话」时模型下拉是空的 ——
 * 界面上就是「模型未就绪」（用户报的那个 bug）。修法是切引擎时开一条**临时会话**把目录抄下来
 * （见 catalog-probe.ts），所以这里钉死三件事：
 *   1. `prewarm()` 之后**不开任何会话**也能列出模型；
 *   2. 探针会话在**临时目录**里（`isScratchCwd` → 侧栏不会看到），而且用完就收掉（关 + 删）；
 *   3. 只探一次：反复 `prewarm()`（切会话 / 发消息都会走）不能每次都建一条会话。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeEngine } from "../../server/engine/claude.ts";
import { encodeProjectPath } from "../../server/engine/claude-sessions.ts";
import { createDshEngine } from "../../server/engine/dsh.ts";
import { projectKey } from "../../server/engine/dsh-log.ts";
import { createOpencodeEngine } from "../../server/engine/opencode.ts";
import { isScratchCwd } from "../../server/engine/scratch.ts";

type Call = { method: string; params: Record<string, unknown> };

/** 三个引擎共用的假 ACP 客户端：只认探针会用到的那几个方法 */
function fakeClient(handler: (call: Call) => unknown) {
	const calls: Call[] = [];
	const client = {
		async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
			const call = { method, params };
			calls.push(call);
			return (await handler(call)) as T;
		},
		notify: () => {},
		respond: () => {},
		respondError: () => {},
		onNotification: () => () => {},
		onServerRequest: () => () => {},
		onExit: () => () => {},
		ensureStarted: async () => {},
		version: () => "test",
		isReady: () => true,
		close: () => {},
	};
	return { client, calls };
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("opencode：prewarm 拿到模型目录，探针会话在临时目录里且用完就删", async () => {
	const deleted: string[] = [];
	const { client, calls } = fakeClient((call) => {
		if (call.method === "session/new") {
			return {
				sessionId: "ses_probe",
				configOptions: [
					{
						id: "model",
						category: "model",
						currentValue: "opencode/deepseek-flash",
						options: [{ value: "opencode/deepseek-flash", name: "deepseek-flash" }],
					},
				],
			};
		}
		return {};
	});
	const engine = createOpencodeEngine({ client: client as never, deleteSession: async (id) => void deleted.push(id) });

	// 还没预热：一个会话都没有 → 列表必须是空的（这就是用户看到的那一幕）
	assert.equal((await engine.listModels())?.length, 0);

	await engine.prewarm();
	const models = await engine.listModels();
	assert.deepEqual(
		models?.map((model) => model.id),
		["opencode/deepseek-flash"],
	);
	// 当前模型也得知道（空状态下选择器与芯片要显示它）
	assert.deepEqual(await engine.currentModel(), { provider: "opencode", model: "deepseek-flash" });

	const created = calls.find((call) => call.method === "session/new");
	assert.ok(created, "prewarm 应该开一条临时会话去拿目录");
	assert.ok(isScratchCwd(String(created.params.cwd)), `探针目录必须是临时目录：${created.params.cwd}`);
	// 收尾：先关（放写句柄）再删（不开 opencode 自己的历史里留空会话）
	assert.ok(calls.some((call) => call.method === "session/close"));
	assert.deepEqual(deleted, ["ses_probe"]);

	// 再预热一次（切会话 / 发消息都会走 prewarm）：不能再建会话
	await engine.prewarm();
	assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
});

test("dsh：prewarm 拿到模型目录，探针会话的日志目录被删掉", async () => {
	const home = tempDir("omaw-dsh-");
	let probeCwd = "";
	const { client, calls } = fakeClient((call) => {
		if (call.method === "session/new") {
			probeCwd = String(call.params.cwd);
			// 模拟 DSH 自己落盘的会话目录：<home>/sessions/<projectKey>/<sessionId>/
			mkdirSync(join(home, "sessions", projectKey(probeCwd), "s-probe"), { recursive: true });
			return {
				sessionId: "s-probe",
				configOptions: [
					{
						id: "model",
						category: "model",
						currentValue: "deepseek-official/deepseek-v4-flash",
						options: [
							{
								group: "deepseek-official",
								options: [{ value: "deepseek-official/deepseek-v4-flash", name: "deepseek-v4-flash" }],
							},
						],
					},
					{
						id: "reasoning_effort",
						category: "thought_level",
						currentValue: "high",
						options: ["off", "low", "high", "max"].map((value) => ({ value })),
					},
				],
			};
		}
		return {};
	});
	const engine = createDshEngine({ client: client as never, home } as never);

	try {
		await engine.prewarm();
		const models = await engine.listModels();
		assert.deepEqual(
			models?.map((model) => model.id),
			["deepseek-official/deepseek-v4-flash"],
		);
		// 思考档也要跟着可用（否则空状态下那一格是死的）
		assert.deepEqual(await engine.listThinkingLevels(), ["off", "low", "high", "max"]);
		assert.equal(await engine.getThinkingLevel(), "high");

		assert.ok(isScratchCwd(probeCwd), `探针目录必须是临时目录：${probeCwd}`);
		assert.ok(calls.some((call) => call.method === "session/close"));
		assert.equal(
			existsSync(join(home, "sessions", projectKey(probeCwd), "s-probe")),
			false,
			"探针会话在 DSH 自己的存储里也要删掉",
		);

		await engine.prewarm();
		assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("claude：prewarm 拿到 models 表，探针会话的 JSONL 被删掉", async () => {
	const home = tempDir("omaw-claude-");
	let probeFile = "";
	const { client, calls } = fakeClient((call) => {
		if (call.method === "session/new") {
			// 模拟 claude 自己落盘的会话文件：<home>/projects/<encoded cwd>/<sessionId>.jsonl
			const dir = join(home, "projects", encodeProjectPath(String(call.params.cwd)));
			probeFile = join(dir, "c-probe.jsonl");
			mkdirSync(dir, { recursive: true });
			writeFileSync(probeFile, "{}\n");
			return {
				sessionId: "c-probe",
				models: {
					availableModels: [
						{ modelId: "opus", name: "Opus" },
						{ modelId: "haiku", name: "Haiku" },
					],
					currentModelId: "opus",
				},
			};
		}
		return {};
	});
	const engine = createClaudeEngine({ client: client as never, home, bin: "claude-code-acp" });

	try {
		await engine.prewarm();
		const models = await engine.listModels();
		assert.deepEqual(
			models?.map((model) => model.id),
			["anthropic/opus", "anthropic/haiku"],
		);
		assert.deepEqual(await engine.currentModel(), { provider: "anthropic", model: "opus" });

		const created = calls.find((call) => call.method === "session/new");
		assert.ok(created && isScratchCwd(String(created.params.cwd)));
		// 这套 ACP 面没有 session/close（parkSession 也只是本地停用）→ 不该去调它，只能删文件
		assert.equal(
			calls.some((call) => call.method === "session/close"),
			false,
		);
		assert.ok(probeFile !== "");
		assert.equal(existsSync(probeFile), false, "探针会话的 JSONL 要删掉");
		assert.equal(models?.filter((model) => model.current)?.length ?? 0, 1);

		await engine.prewarm();
		assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
