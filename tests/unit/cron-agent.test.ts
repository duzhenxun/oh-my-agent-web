/**
 * cron 的 agent 任务：无人值守下的行为边界。
 *
 * 重点不是「能跑通」，而是几条一旦搞错就会出事的地方：
 *   - 默认**只读**：需要审批的写操作要当场被拒，不能挂在一个没人的弹窗上；
 *   - 超时/停机要真的中断，并把运行记成失败（不拿半截输出当结果）；
 *   - 运行结束后策略必须清掉，不能把「无人值守放行」留给用户后面的手动会话。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRunner, finalAssistantText, type AgentRunnerDeps } from "../../server/cron/agent-run.js";
import { createCronService } from "../../server/cron/index.js";
import { unattendedPolicyOf } from "../../server/approval/unattended.js";
import type { UiMessage } from "../../server/protocol.js";

const dirs: string[] = [];
async function makeDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cron-agent-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const assistant = (text: string): UiMessage => ({
	id: `m-${text}`,
	role: "assistant",
	ts: 1,
	type: "assistant",
	blocks: [{ kind: "text", text }],
} as UiMessage);

type Harness = {
	deps: AgentRunnerDeps;
	/** 观察用的记录 */
	seen: {
		approvalModes: Array<{ mode: string; conversationId: string }>;
		policyDuringTurn: string | null;
		interrupted: string[];
		prompts: Array<{ text: string; conversationId: string }>;
		models: Array<{ model: string; conversationId: string }>;
		opened: string[];
	};
	/** 手动结束回合（模拟引擎跑完） */
	finish: (info?: { failed?: boolean; interrupted?: boolean }) => void;
};

function harness(options: {
	messages?: UiMessage[];
	sendOk?: boolean;
	busy?: boolean;
	missingSession?: boolean;
	onSend?: (text: string, conversationId: string) => void;
} = {}): Harness {
	const listeners = new Set<(info: { conversationId: string; failed: boolean; interrupted: boolean }) => void>();
	let conversationId = "";
	const seen: Harness["seen"] = {
		approvalModes: [],
		policyDuringTurn: null,
		interrupted: [],
		prompts: [],
		models: [],
		opened: [],
	};
	const deps: AgentRunnerDeps = {
		newConversation: async () => {
			conversationId = "conv-1";
			return { ok: true, conversationId };
		},
		setApprovalMode: (mode, id) => {
			seen.approvalModes.push({ mode, conversationId: id });
		},
		sendMessage: async (text, id) => {
			seen.prompts.push({ text, conversationId: id });
			// 发送这一刻的策略才是真正生效的那份 —— 结束后会被清掉，所以必须当场记
			seen.policyDuringTurn = unattendedPolicyOf(id);
			options.onSend?.(text, id);
			return options.sendOk === false ? { ok: false, error: { message: "engine busy" } } : { ok: true };
		},
		interrupt: async (id) => {
			seen.interrupted.push(id);
		},
		getApprovalMode: () => "allow",
		conversationExists: (id) => (options.missingSession ? false : id === "conv-1" || id === "existing-1"),
		openConversation: async (id) => {
			seen.opened.push(id);
			return { ok: true as const };
		},
		conversationBusy: () => options.busy === true,
		setModel: async (model, id) => {
			seen.models.push({ model, conversationId: id });
			return { ok: true };
		},
		messages: () => options.messages ?? [assistant("done")],
		subscribeTurnEnd: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		deps,
		seen,
		finish: (info) =>
			// 用 queueMicrotask 模拟「引擎稍后才跑完」
			queueMicrotask(() =>
				listeners.forEach((listener) =>
					listener({ conversationId, failed: info?.failed ?? false, interrupted: info?.interrupted ?? false }),
				),
			),
	};
}

describe("agent 任务：权限边界", () => {
	it("默认只读：会话模式是 ask，且运行期间策略是 deny-writes", async () => {
		const h = harness({ onSend: () => h.finish() });
		const run = createAgentRunner(h.deps);
		const result = await run({ prompt: "检查一下仓库", workspace: "/work", allowWrites: false, signal: new AbortController().signal });
		assert.equal(result, "done");
		// 进入时设成 ask，跑完还原成用户原来的模式（harness 里是 allow）：
		// 两次调用都是必须的，后者保证不把用户的会话永久改成只读
		assert.deepEqual(h.seen.approvalModes, [
			{ mode: "ask", conversationId: "conv-1" },
			{ mode: "allow", conversationId: "conv-1" },
		]);
		assert.equal(h.seen.policyDuringTurn, "deny-writes");
		assert.equal(unattendedPolicyOf("conv-1"), null, "运行结束后策略必须清掉");
	});

	it("显式开启写入时才整体放行（模式 allow / 策略 allow）", async () => {
		const h = harness({ onSend: () => h.finish() });
		const run = createAgentRunner(h.deps);
		await run({ prompt: "修掉测试失败", workspace: "/work", allowWrites: true, signal: new AbortController().signal });
		assert.deepEqual(h.seen.approvalModes, [
			{ mode: "allow", conversationId: "conv-1" },
			{ mode: "allow", conversationId: "conv-1" },
		]);
		assert.equal(h.seen.policyDuringTurn, "allow");
		assert.equal(unattendedPolicyOf("conv-1"), null);
	});
});

describe("agent 任务：选会话与选模型", () => {
	it("选中已有会话时续跑它，不再新建", async () => {
		const h = harness({ onSend: () => h.finish() });
		await createAgentRunner(h.deps)({
			prompt: "继续上次的活",
			workspace: "/work",
			allowWrites: false,
			signal: new AbortController().signal,
			sessionId: "existing-1",
		});
		assert.deepEqual(h.seen.prompts, [{ text: "继续上次的活", conversationId: "existing-1" }]);
	});

	it("指定模型时先打开会话再切模型（否则历史会话拿不到句柄）", async () => {
		const h = harness({ onSend: () => h.finish() });
		await createAgentRunner(h.deps)({
			prompt: "x",
			workspace: "/work",
			allowWrites: false,
			signal: new AbortController().signal,
			sessionId: "existing-1",
			model: "deepseek/v4",
		});
		assert.deepEqual(h.seen.opened, ["existing-1"]);
		assert.deepEqual(h.seen.models, [{ model: "deepseek/v4", conversationId: "existing-1" }]);
	});

	it("会话不存在 / 正在运行时给出清楚的错误，而不是悄悄新建一个", async () => {
		const missing = harness({ missingSession: true });
		await assert.rejects(
			createAgentRunner(missing.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
				sessionId: "gone-1",
			}),
			/指定的会话不存在/,
		);
		const busy = harness({ busy: true });
		await assert.rejects(
			createAgentRunner(busy.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
				sessionId: "existing-1",
			}),
			/正在运行/,
		);
	});
});

describe("agent 任务：收尾与异常", () => {
	it("超时会中断并把运行判为失败", async () => {
		const h = harness(); // 永不结束
		const run = createAgentRunner(h.deps);
		await assert.rejects(
			run({ prompt: "长任务", workspace: "/work", allowWrites: false, signal: new AbortController().signal, timeoutMs: 20 }),
			/已中断/,
		);
		assert.deepEqual(h.seen.interrupted, ["conv-1"]);
		assert.equal(unattendedPolicyOf("conv-1"), null);
	});

	it("服务停机（signal 中止）会中断运行", async () => {
		const h = harness();
		const controller = new AbortController();
		const run = createAgentRunner(h.deps);
		const pending = run({ prompt: "长任务", workspace: "/work", allowWrites: false, signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, /正在停止/);
		assert.deepEqual(h.seen.interrupted, ["conv-1"]);
	});

	it("被中断 / 失败的回合不当成成功结果", async () => {
		const interrupted = harness({ onSend: () => interrupted.finish({ interrupted: true }) });
		await assert.rejects(
			createAgentRunner(interrupted.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
			}),
			/被中断/,
		);

		const failed = harness({ messages: [assistant("报错原因：401 未授权")], onSend: () => failed.finish({ failed: true }) });
		await assert.rejects(
			createAgentRunner(failed.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
			}),
			/运行失败：报错原因/,
		);
	});

	it("发送失败时立即报错，不等超时", async () => {
		const h = harness({ sendOk: false });
		await assert.rejects(
			createAgentRunner(h.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
			}),
			/发送失败：engine busy/,
		);
	});

	it("没有正文算失败，不写一条空结果", async () => {
		const h = harness({ messages: [], onSend: () => h.finish() });
		await assert.rejects(
			createAgentRunner(h.deps)({
				prompt: "x",
				workspace: "/work",
				allowWrites: false,
				signal: new AbortController().signal,
			}),
			/没有产出正文/,
		);
	});

	it("超长结果被截断（别把 cron.json 撑大）", async () => {
		const h = harness({ messages: [assistant("a".repeat(5000))], onSend: () => h.finish() });
		const result = await createAgentRunner(h.deps)({
			prompt: "x",
			workspace: "/work",
			allowWrites: false,
			signal: new AbortController().signal,
		});
		assert.ok(result.length < 4200);
		assert.match(result, /已截断/);
	});

	it("finalAssistantText 取最后一条 assistant 的正文，忽略思考与工具块", () => {
		const messages = [
			{ id: "1", role: "assistant", ts: 1, blocks: [{ kind: "thinking", text: "想" }, { kind: "text", text: "旧结论" }] },
			{ id: "2", role: "user", ts: 2, blocks: [{ kind: "text", text: "用户" }] },
			{ id: "3", role: "assistant", ts: 3, blocks: [{ kind: "text", text: "最终结论" }] },
		] as UiMessage[];
		assert.equal(finalAssistantText(messages), "最终结论");
		assert.equal(finalAssistantText([] as UiMessage[]), "");
	});
});

describe("cron 任务的 mode / allowWrites 落库", () => {
	const draft = (patch: Record<string, unknown> = {}) => ({
		name: "job",
		workspace: "/work",
		prompt: "run",
		expression: "0 9 * * *",
		timezone: "UTC",
		enabled: false,
		...patch,
	});

	it("缺省是文本任务；agent 任务的写入开关只在 agent 下保留", async () => {
		const dataDir = await makeDataDir();
		const service = createCronService({ dataDir, execute: async () => "ok", workspaces: () => ["/work"] });
		const legacy = await service.create(draft());
		assert.equal(legacy.mode, "text");
		assert.equal(legacy.allowWrites, false);

		const agent = await service.create(draft({ mode: "agent", allowWrites: true }));
		assert.equal(agent.mode, "agent");
		assert.equal(agent.allowWrites, true);

		// 文本任务带 allowWrites 会被规范化成 false：不能让人以为一段提示词也能改文件
		const coerced = await service.create(draft({ mode: "text", allowWrites: true }));
		assert.equal(coerced.allowWrites, false);

		const snapshot = await service.snapshot();
		assert.deepEqual(
			snapshot.jobs.map((job) => [job.mode, job.allowWrites]),
			[
				["text", false],
				["agent", true],
				["text", false],
			],
		);
	});

	it("非法 mode / allowWrites 被拒绝，而不是静默当成文本任务", async () => {
		const dataDir = await makeDataDir();
		const service = createCronService({ dataDir, execute: async () => "ok", workspaces: () => ["/work"] });
		await assert.rejects(service.create(draft({ mode: "shell" })), /mode must be text or agent/);
		await assert.rejects(service.create(draft({ mode: "agent", allowWrites: "yes" })), /allowWrites must be boolean/);
	});
});
