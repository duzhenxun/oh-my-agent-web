/**
 * codex 原生多代理 → 面板运行卡片（`server/engine/codex-subagents.ts`）。
 *
 * 这里锁的是**实测到的形状**（codex-cli 0.162.1 + `features.multi_agent_v2=true`）：
 *   - `subAgentActivity`：started / interacted / interrupted / completed，带 agentThreadId + agentPath + model
 *   - `collabAgentToolCall`：tool + status + agentsStates（每个子 thread 的权威状态）
 * 错一处的后果不是「界面难看」：卡片会一直转圈（永远 running），或者「停止」找不到目标 thread。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activityPatch,
	agentTypeId,
	collabStatesPatch,
	codexMultiAgentConfig,
	codexSubagentGuidance,
	createCodexSubagents,
	statusOfAgentState,
	taskNameOf,
	type CodexSubAgentActivityItem,
} from "../../server/engine/codex-subagents.ts";

const activity = (patch: Partial<CodexSubAgentActivityItem>): CodexSubAgentActivityItem => ({
	type: "subAgentActivity",
	agentThreadId: "th-1",
	agentPath: "/root/directory_inventory",
	...patch,
});

describe("agentTypeId", () => {
	it("我们的模板 id 映射成 codex 认的类型名（小写 + 下划线）", () => {
		assert.equal(agentTypeId("general-purpose"), "general_purpose");
		assert.equal(agentTypeId("Explore"), "explore");
		assert.equal(agentTypeId("  a b  "), "a_b");
	});

	it("怪名字也有兜底（空 / 全是符号）", () => {
		assert.equal(agentTypeId(""), "subagent");
		assert.equal(agentTypeId("***"), "subagent");
	});
});

describe("taskNameOf", () => {
	it("取 agentPath 最后一段并变成人看的标题", () => {
		assert.equal(taskNameOf("/root/directory_inventory", "x"), "Directory inventory");
		assert.equal(taskNameOf("/root/task1/task_3", "x"), "Task 3");
	});

	it("没有 agentPath 时用兜底（thread id 前 8 位）", () => {
		assert.equal(taskNameOf(null, "abcd1234"), "abcd1234");
	});
});

describe("statusOfAgentState", () => {
	it("codex 的七个状态都能落到面板的三态 + 失败", () => {
		assert.equal(statusOfAgentState("running"), "running");
		assert.equal(statusOfAgentState("pendingInit"), "running");
		assert.equal(statusOfAgentState("completed"), "completed");
		assert.equal(statusOfAgentState("interrupted"), "aborted");
		assert.equal(statusOfAgentState("shutdown"), "aborted");
		assert.equal(statusOfAgentState("errored"), "failed");
	});

	it("未见过 / 空值不动状态（不能把卡片瞎结账）", () => {
		assert.equal(statusOfAgentState("notFound"), null);
		assert.equal(statusOfAgentState(undefined), null);
	});
});

describe("activityPatch", () => {
	it("started → running，并带上模型与任务名", () => {
		const patch = activityPatch(activity({ kind: "started", model: "deepseek-flash" }), 1000);
		assert.deepEqual(patch, {
			threadId: "th-1",
			label: "Directory inventory",
			model: "deepseek-flash",
			status: "running",
		});
	});

	it("completed / interrupted 带 endedAt（卡片要停表）", () => {
		assert.deepEqual(activityPatch(activity({ kind: "completed" }), 2000), {
			threadId: "th-1",
			label: "Directory inventory",
			status: "completed",
			endedAt: 2000,
		});
		assert.equal(activityPatch(activity({ kind: "interrupted" }), 3000)?.status, "aborted");
	});

	it("没有 agentThreadId 的 item 直接忽略（不能拿它当一条运行）", () => {
		assert.equal(activityPatch(activity({ agentThreadId: undefined }), 1), null);
	});
});

describe("collabStatesPatch", () => {
	it("按 agentsStates 逐个 thread 给状态（含失败原因）", () => {
		const patches = collabStatesPatch({
			type: "collabAgentToolCall",
			tool: "wait",
			agentsStates: {
				"th-1": { status: "completed" },
				"th-2": { status: "errored", message: "model overloaded" },
			},
		});
		assert.deepEqual(
			patches.map((patch) => [patch.threadId, patch.status, patch.error]),
			[
				["th-1", "completed", undefined],
				["th-2", "failed", "model overloaded"],
			],
		);
	});

	it("spawnAgent 的 prompt 会落到新 thread 的 task 上（面板要能看原文）", () => {
		const patches = collabStatesPatch({
			type: "collabAgentToolCall",
			tool: "spawnAgent",
			prompt: "看看 /tmp 里有什么",
			receiverThreadIds: ["th-9"],
			agentsStates: { "th-9": { status: "running" } },
		});
		assert.equal(patches[0]?.task, "看看 /tmp 里有什么");
	});

	it("spawn 时 agentsStates 还是空的：按 receiverThreadIds 补一条 running（否则面板没有任务原文）", () => {
		const patches = collabStatesPatch({
			type: "collabAgentToolCall",
			tool: "spawnAgent",
			prompt: "统计 .ts 文件数量",
			receiverThreadIds: ["th-7"],
			agentsStates: {},
		});
		assert.deepEqual(patches, [{ threadId: "th-7", status: "running", task: "统计 .ts 文件数量" }]);
	});

	it("wait 自己的状态不算子代理状态（wait 结束 ≠ 子代理跑完）", () => {
		const patches = collabStatesPatch({
			type: "collabAgentToolCall",
			tool: "wait",
			status: "completed",
			agentsStates: {},
		});
		assert.deepEqual(patches, []);
	});
});

describe("codexMultiAgentConfig", () => {
	it("默认 v1：只开多代理 + 写并发上限（v1 没有可按类型挑的子代理，别写假的类型）", () => {
		const config = codexMultiAgentConfig({
			enabled: true,
			concurrency: 3,
			profiles: [{ id: "general-purpose", label: "General purpose", description: "通用委派" }],
		});
		assert.deepEqual(config, {
			features: { multi_agent: true, multi_agent_v2: false },
			agents: { max_concurrent_threads_per_session: 3 },
		});
	});

	it("显式 v2 时才写模板类型（并把 v2 打开）", () => {
		const config = codexMultiAgentConfig({
			enabled: true,
			concurrency: 3,
			profiles: [{ id: "general-purpose", label: "General purpose", description: "通用委派" }],
			version: "v2",
		});
		assert.deepEqual(config, {
			features: { multi_agent: true, multi_agent_v2: true },
			agents: {
				max_concurrent_threads_per_session: 3,
				general_purpose: { description: "General purpose：通用委派" },
			},
		});
	});

	it("关闭时：只留并发上限，不定义任何类型（模型干脆没有 spawn 工具）", () => {
		const config = codexMultiAgentConfig({
			enabled: false,
			concurrency: 4,
			profiles: [{ id: "explore", label: "Explore", description: "只读侦察" }],
			version: "v2",
		});
		assert.deepEqual(config, {
			features: { multi_agent: false, multi_agent_v2: false },
			agents: { max_concurrent_threads_per_session: 4 },
		});
	});

	it("并发数被夹在 1..16（面板再怎么传也不会把 codex 的槽位写成 0）", () => {
		const low = codexMultiAgentConfig({ enabled: true, concurrency: 0, profiles: [] });
		const high = codexMultiAgentConfig({ enabled: true, concurrency: 99, profiles: [] });
		assert.equal((low.agents as Record<string, number>).max_concurrent_threads_per_session, 1);
		assert.equal((high.agents as Record<string, number>).max_concurrent_threads_per_session, 16);
	});
});

describe("codexSubagentGuidance", () => {
	it("关掉 / 没模板时不给说明（别让模型以为能派活）", () => {
		assert.equal(codexSubagentGuidance({ enabled: false, profiles: [] }), null);
		assert.equal(codexSubagentGuidance({ enabled: true, profiles: [] }), null);
	});

	it("开着时（默认 v1）：只讲 codex 真有的工具 + 把模板写成委派说明 + 明确「别自作主张」", () => {
		const text = codexSubagentGuidance({
			enabled: true,
			profiles: [{ id: "general-purpose", label: "General purpose", description: "通用委派" }],
		});
		assert.ok(text);
		assert.match(text, /spawn_agent/);
		// v1 没有 agent_type：模板名按人看的写，别让模型去传一个不存在的类型
		assert.match(text, /- General purpose: 通用委派/);
		assert.ok(!text.includes("general_purpose"));
		assert.match(text, /explicitly asks/);
		assert.match(text, /message/);
		// 不能把 pi 的工具名写进去（模型会照着调一个不存在的工具）
		assert.ok(!text.includes("`Agent` tool"));
	});

	it("显式 v2 时：模板以 `agent_type` 的名字出现", () => {
		const text = codexSubagentGuidance({
			enabled: true,
			version: "v2",
			profiles: [{ id: "general-purpose", label: "General purpose", description: "通用委派" }],
		});
		assert.ok(text);
		assert.match(text, /general_purpose/);
		assert.match(text, /agent_type/);
	});
});

describe("createCodexSubagents", () => {
	const make = (request: (method: string, params?: unknown) => Promise<unknown>) =>
		createCodexSubagents({ request: (method, params) => request(method, params) as never, now: () => 1000 });

	it("started → 卡片出现；completed → 结算并读回子 thread 的最后一条答复", async () => {
		const calls: string[] = [];
		const port = make(async (method) => {
			calls.push(method);
			if (method === "thread/turns/list") {
				return { data: [{ items: [{ type: "agentMessage", text: "目录里有 a.txt" }] }] };
			}
			return {};
		});
		const seen: string[] = [];
		const off = port.subscribe((run) => seen.push(`${run.status}:${run.label}`));
		port.ingest("conv-1", activity({ kind: "started" }));
		port.ingest("conv-1", activity({ kind: "completed" }));
		off();
		assert.deepEqual(seen, ["running:Directory inventory", "completed:Directory inventory"]);
		const run = port.get("codex:th-1");
		assert.equal(run?.status, "completed");
		// 读结果是异步的：等一轮微任务
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(port.get("codex:th-1")?.result, "目录里有 a.txt");
		assert.ok(calls.includes("thread/turns/list"));
	});

	it("interrupt：先查子 thread 最近一轮，再打断它（codex 的 interrupt 要 turnId）", async () => {
		const calls: { method: string; params?: unknown }[] = [];
		const port = make(async (method, params) => {
			calls.push({ method, params });
			if (method === "thread/turns/list") return { data: [{ id: "turn-9" }] };
			return {};
		});
		port.ingest("conv-1", activity({ kind: "started" }));
		await port.interrupt("codex:th-1");
		assert.deepEqual(calls.at(-1), { method: "turn/interrupt", params: { threadId: "th-1", turnId: "turn-9" } });
	});

	it("start() 直接给一句人话（codex 的委派由模型发起，面板不伪造）", async () => {
		const port = make(async () => ({}));
		await assert.rejects(
			() =>
				port.start({
					conversationId: "c",
					workspace: "/tmp",
					parentSessionPath: null,
					profile: { id: "explore", label: "Explore", systemPrompt: "", tools: [] },
					description: "d",
					task: "t",
				}),
			/由引擎自己发起/,
		);
	});

	it("setConcurrency 夹在 1..16 且能被建会话读到", () => {
		const port = make(async () => ({}));
		port.setConcurrency(0);
		assert.equal(port.concurrency(), 1);
		port.setConcurrency(99);
		assert.equal(port.concurrency(), 16);
	});
});
