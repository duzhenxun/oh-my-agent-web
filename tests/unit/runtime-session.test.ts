/**
 * 会话持久化 / 切换 / 审批规则（M2 + M3）。
 * 共用夹具与 M1 部分共享：helpers/runtime-harness.ts。
 */
import { describe, expect, it } from "vitest";
import type { RuleStore } from "../../server/approval/rules.js";
import { createMemoryRuleStore } from "../../server/approval/rules.js";
import { createFakeEngine } from "../../server/engine/fake.js";
import { messagesToHistory } from "../../server/session/engine-binding.js";
import { createMemoryStore } from "../../server/session/store.js";
import {
	appendTextForTest,
	createMessageForTest,
	harness,
	messageTextForTest,
	waitFor,
} from "./helpers/runtime-harness.js";

describe("M2：会话持久化与切换（ADR-0005）", () => {
	function seededStore() {
		return createMemoryStore({
			conversations: [
				{
					id: "old-1",
					title: "以前的会话",
					createdAt: 100,
					updatedAt: 200,
					workspace: "/tmp/agent-web-test",
					messageCount: 2,
				},
			],
			messages: {
				"old-1": [
					appendTextForTest(createMessageForTest("m-old-1", "user", 150), "以前问的"),
					appendTextForTest(createMessageForTest("m-old-2", "assistant", 151), "以前答的"),
				],
			},
		});
	}

	async function harnessWithSeed() {
		const store = seededStore();
		const instance = harness(store);
		await instance.runtime.init();
		return instance;
	}

	it("init 装载索引里的会话（重启后侧栏还有会话）", async () => {
		const { runtime } = await harnessWithSeed();
		const snapshot = runtime.snapshot();
		expect(snapshot.conversations.map((meta) => meta.id)).toEqual(["old-1"]);
		expect(snapshot.active.conversationId).toBeNull(); // 需要用户点开（不会偷偷占用一个会话）
	});

	it("switchConversation 把历史消息从存储读进快照", async () => {
		const { runtime: seeded } = await harnessWithSeed();
		expect(seeded.snapshot().active.messages).toEqual([]); // 还没点开任何会话

		const result = await seeded.switchConversation("old-1");
		expect(result.ok).toBe(true);
		const snapshot = seeded.snapshot();
		expect(snapshot.active.conversationId).toBe("old-1");
		expect(snapshot.active.messages.map((message) => message.id)).toEqual(["m-old-1", "m-old-2"]);
		expect(messageTextForTest(snapshot)).toContain("以前问的");
	});

	it("切换不存在的会话被拒（session.not_found）", async () => {
		const { runtime } = await harnessWithSeed();
		const result = await runtime.switchConversation("不存在");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("session.not_found");
	});

	it("newConversation 建一个新会话并切过去（索引里也多一条）", async () => {
		const { runtime, store } = await harnessWithSeed();
		const result = await runtime.newConversation();
		expect(result.ok).toBe(true);

		const snapshot = runtime.snapshot();
		expect(snapshot.conversations).toHaveLength(2);
		expect(snapshot.active.conversationId).toBeTruthy();
		expect(snapshot.active.messages).toEqual([]);
		expect(snapshot.conversations.find((meta) => meta.id === snapshot.active.conversationId)?.title).toBe("新对话");
		expect((await store.readMessages(snapshot.active.conversationId!)).messages).toEqual([]);
	});

	it("首条用户消息决定标题（并且落盘）", async () => {
		const { runtime } = await harness();
		await runtime.sendMessage("帮我给登录加个限流");
		const active = runtime.snapshot().conversations[0];
		expect(active.title).toBe("帮我给登录加个限流");
		expect(active.messageCount).toBe(2);
	});

	it("落盘顺序：用户消息立即写，助手消息在回合结束时整条写", async () => {
		const { runtime, store } = await harness();
		await runtime.sendMessage("hello");
		const conversationId = runtime.snapshot().active.conversationId!;
		const stored = await store.readMessages(conversationId);
		expect(stored.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(stored.messages[1].blocks.some((block) => block.kind === "text")).toBe(true);
	});

	it("切换会话不中断在跑的回合：切回来看得到结果", async () => {
		const { runtime } = await harness();
		await runtime.newConversation();
		const first = runtime.snapshot().active.conversationId!;
		await runtime.newConversation();
		const second = runtime.snapshot().active.conversationId!;

		const turn = runtime.sendMessage("slow please");
		// 等待纪律：断言的既然是「状态是 streaming」，就等这个状态本身（isBusy 会早于它变 true）
		await waitFor(() => runtime.snapshot().running.status === "streaming");

		// 切到另一个会话：回合继续在服务端跑
		await runtime.switchConversation(first);
		expect(runtime.snapshot().active.conversationId).toBe(first);
		expect(runtime.snapshot().running.status).toBe("streaming");
		expect(runtime.snapshot().active.messages).toEqual([]); // 这是另一个会话，还没内容

		// 切回去：内容在（同一时刻只有一个回合在飞，但内容归属各自的会话）
		await runtime.switchConversation(second);
		expect(runtime.snapshot().active.messages.length).toBe(2);

		// 中断：中断的是「在飞的那个回合」，不是当前正在看的会话
		const result = await runtime.interrupt();
		expect(result.ok).toBe(true);
		await turn;
		expect(runtime.snapshot().running.status).toBe("idle");
	});
});

describe("M3：审批规则跨重启（ADR-0006 的「总是允许这类」）", () => {
	it("「总是允许这类」写进规则库，下一次运行不再询问", async () => {
		const rules = createMemoryRuleStore();
		const first = harness(createMemoryStore(), rules);

		const turn = first.runtime.sendMessage("approve please");
		await waitFor(() => first.runtime.snapshot().pendingApproval !== null);
		first.runtime.approve(first.runtime.snapshot().pendingApproval!.requestId, "always");
		await turn;

		const stored = await rules.load();
		expect(stored.map((rule) => rule.scopeKey)).toEqual(["write_file|/Users/me/code/agent-web/docs"]);
		expect(stored[0].scopeHint).toContain("目录");

		// 新的一次运行（新 runtime、同一规则库）→ 同类操作不再弹窗
		const second = harness(createMemoryStore(), rules);
		await second.runtime.init();
		await second.runtime.sendMessage("approve please");
		expect(second.recorder.snapshots.some((snapshot) => snapshot.pendingApproval !== null)).toBe(false);
		expect(messageTextForTest(second.runtime.snapshot())).toContain("审批结果：always");
	});

	it("init 装载规则并提示「这些操作不会再询问」", async () => {
		const rules = createMemoryRuleStore([{ scopeKey: "bash|npm", scopeHint: "命令 npm", createdAt: 1 }]);
		const { runtime } = harness(createMemoryStore(), rules);
		await runtime.init();
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("审批规则"))).toBe(true);
	});

	it("「允许一次」不写规则（这正是三态的意义）", async () => {
		const rules = createMemoryRuleStore();
		const first = harness(createMemoryStore(), rules);

		const turn = first.runtime.sendMessage("approve please");
		await waitFor(() => first.runtime.snapshot().pendingApproval !== null);
		first.runtime.approve(first.runtime.snapshot().pendingApproval!.requestId, "once");
		await turn;

		expect(await rules.load()).toEqual([]);
	});

	it("规则写盘失败只警告，不阻塞回合（in-memory 规则仍然生效）", async () => {
		const rules: RuleStore = {
			load: async () => [],
			save: async () => {
				throw new Error("磁盘满了");
			},
		};
		const { runtime } = harness(createMemoryStore(), rules);
		const turn = runtime.sendMessage("approve please");
		await waitFor(() => runtime.snapshot().pendingApproval !== null);
		runtime.approve(runtime.snapshot().pendingApproval!.requestId, "always");
		expect((await turn).ok).toBe(true);

		// 第二次同类操作：内存规则已经生效
		await runtime.sendMessage("approve please");
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("写盘失败"))).toBe(true);
	});
});

describe("M3 修：引擎会话的生命周期与历史注入（ADR-0018）", () => {
	it("假引擎忠实复现真引擎：没建会话就发 → engine.no_session", async () => {
		const engine = createFakeEngine({ chunkDelayMs: 0 });
		const events: string[] = [];
		await engine.sendMessage("nope", "hi", (event) => events.push(event.type));
		expect(events).toEqual(["error", "turn_end"]);
	});

	it("重启后（新 runtime + 同一 store）能给旧会话发消息，并把历史交给引擎", async () => {
		const store = createMemoryStore({
			conversations: [
				{
					id: "old-1",
					title: "以前的会话",
					createdAt: 100,
					updatedAt: 200,
					workspace: "/tmp/agent-web-test",
					messageCount: 2,
				},
			],
			messages: {
				"old-1": [
					appendTextForTest(createMessageForTest("m1", "user", 150), "以前问的"),
					appendTextForTest(createMessageForTest("m2", "assistant", 151), "以前答的"),
				],
			},
		});
		const { runtime, engine } = harness(store);
		await runtime.init();
		await runtime.switchConversation("old-1");

		const result = await runtime.sendMessage("接着聊");
		expect(result.ok).toBe(true);

		// 1) 引擎确实被建了起来，且拿到了历史（否则模型失忆）
		const session = engine.sessions().get("old-1");
		expect(session?.history.map((message) => `${message.role}:${message.text}`)).toEqual([
			"user:以前问的",
			"assistant:以前答的",
		]);
		// 2) 回合正常结束，没有 no_session 错误块
		expect(messageTextForTest(runtime.snapshot())).not.toContain("engine.no_session");
		expect(runtime.snapshot().active.messages.length).toBe(4);
	});

	it("同一个会话只建一次引擎会话（不重复扫描资源）", async () => {
		const { runtime, engine } = harness();
		await runtime.sendMessage("第一轮");
		await runtime.sendMessage("第二轮");
		expect(engine.sessions().size).toBe(1);
		expect(engine.sessions().get(runtime.snapshot().active.conversationId!)?.transcript.length).toBeGreaterThan(0);
	});
});

describe("messagesToHistory（ADR-0018 的纯函数部分）", () => {
	it("只取文本块，工具卡与错误块不进历史", () => {
		const messages = [
			appendTextForTest(createMessageForTest("m1", "user", 1), "帮我看下"),
			{
				...createMessageForTest("m2", "assistant", 2),
				blocks: [
					{ kind: "text" as const, text: "我先读文件：" },
					{
						kind: "tool" as const,
						toolCallId: "t1",
						name: "read",
						argsSummary: "a.ts",
						status: "ok" as const,
						outputExcerpt: "内容",
						truncated: false,
						startedAt: 2,
					},
					{ kind: "text" as const, text: "读完了。" },
					{ kind: "error" as const, code: "x.y", message: "报错" },
				],
			},
		];
		expect(messagesToHistory(messages)).toEqual([
			{ role: "user", text: "帮我看下", ts: 1 },
			{ role: "assistant", text: "我先读文件：读完了。", ts: 2 },
		]);
	});

	it("空白消息被丢掉（不制造空历史）", () => {
		expect(messagesToHistory([createMessageForTest("m1", "user", 1)])).toEqual([]);
	});
});

describe("id 必须全局唯一（ADR-0019）", () => {
	it("两个 runtime（模拟两次启动）生成的会话 id 不重复", async () => {
		const shared = createMemoryStore();
		const first = harness(shared, createMemoryRuleStore(), { deterministicIds: false });
		await first.runtime.sendMessage("第一次启动");
		const firstId = first.runtime.snapshot().active.conversationId!;

		const second = harness(shared, createMemoryRuleStore(), { deterministicIds: false });
		await second.runtime.init();
		await second.runtime.newConversation();
		const secondId = second.runtime.snapshot().active.conversationId!;

		expect(firstId).not.toBe(secondId);
		expect(second.runtime.snapshot().conversations.map((meta) => meta.id)).toEqual(
			expect.arrayContaining([firstId, secondId]),
		);
	});

	it("同一进程内连续两条会话 id 也不同", async () => {
		const { runtime } = harness(createMemoryStore(), createMemoryRuleStore(), { deterministicIds: false });
		await runtime.newConversation();
		const a = runtime.snapshot().active.conversationId!;
		await runtime.newConversation();
		const b = runtime.snapshot().active.conversationId!;
		expect(a).not.toBe(b);
	});
});
