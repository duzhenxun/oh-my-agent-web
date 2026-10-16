import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../../server/engine/fake.js";
import { TOOL_EXCERPT_CHARS, type ServerEvent, type Snapshot } from "../../server/protocol.js";
import { createRuntime, type Runtime } from "../../server/session/runtime.js";
import { createMemoryStore, type ConversationStore } from "../../server/session/store.js";

/** 记录 emit 的快照与事件，便于断言「推了什么、什么时候推」 */
function recorder() {
	const snapshots: Snapshot[] = [];
	const events: ServerEvent[] = [];
	return {
		emit: {
			snapshot: (snapshot: Snapshot) => snapshots.push(snapshot),
			event: (event: ServerEvent) => events.push(event),
		},
		snapshots,
		events,
		latest: () => snapshots[snapshots.length - 1],
		reset: () => {
			snapshots.length = 0;
			events.length = 0;
		},
	};
}

function harness(store: ConversationStore = createMemoryStore()): {
	runtime: Runtime;
	recorder: ReturnType<typeof recorder>;
	store: ConversationStore;
} {
	const recorderInstance = recorder();
	let seq = 0;
	const runtime = createRuntime({
		engine: createFakeEngine({ chunkDelayMs: 0, slowChunkDelayMs: 5 }),
		store,
		workspace: "/tmp/agent-web-test",
		emit: recorderInstance.emit,
		idSeq: (prefix) => `${prefix}-${++seq}`,
	});
	return { runtime, recorder: recorderInstance, store };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("等待超时");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

const assistantText = (snapshot: Snapshot) =>
	snapshot.active.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.blocks)
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("");

describe("会话运行时（M1：内存态）", () => {
	it("默认回合：创建会话、落两条消息、正文走 message_delta 增量", async () => {
		const { runtime, recorder: rec } = harness();
		const result = await runtime.sendMessage("hello");

		expect(result.ok).toBe(true);
		const snapshot = runtime.snapshot();
		expect(snapshot.conversations).toHaveLength(1);
		expect(snapshot.conversations[0].title).toBe("hello");
		expect(snapshot.active.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(assistantText(snapshot)).toContain("假引擎");

		const deltas = rec.events.filter((event) => event.event === "message_delta");
		expect(deltas.length).toBeGreaterThan(3);
		expect(runtime.snapshot().running.status).toBe("idle");
		expect(runtime.snapshot().running.streamingText).toBe("");
	});

	it("工具回合：工具卡从 running 走到 ok", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("tool please");
		const tool = runtime
			.snapshot()
			.active.messages.flatMap((message) => message.blocks)
			.find((block) => block.kind === "tool");
		expect(tool).toMatchObject({ kind: "tool", name: "read_file", status: "ok" });
	});

	it("失败的工具：状态 failed 且带退出码", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("fail please");
		const tool = runtime
			.snapshot()
			.active.messages.flatMap((message) => message.blocks)
			.find((block) => block.kind === "tool");
		expect(tool).toMatchObject({ status: "failed", exitCode: 1 });
	});

	it("超大输出被截断（> TOOL_EXCERPT_CHARS）", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("huge output");
		const tool = runtime
			.snapshot()
			.active.messages.flatMap((message) => message.blocks)
			.find((block) => block.kind === "tool") as { outputExcerpt: string; truncated: boolean };
		expect(tool.truncated).toBe(true);
		expect(tool.outputExcerpt).toHaveLength(TOOL_EXCERPT_CHARS);
	});

	it("报错回合：写入错误块 + notice，状态置 error", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("boom");
		const snapshot = runtime.snapshot();
		const errorBlock = snapshot.active.messages
			.flatMap((message) => message.blocks)
			.find((block) => block.kind === "error");
		expect(errorBlock).toMatchObject({ code: "fake.boom" });
		expect(snapshot.running.status).toBe("error");
		expect(snapshot.notices.some((notice) => notice.level === "error")).toBe(true);
	});

	it("并发保护：已有回合在跑时再发直接被拒（ADR-0005）", async () => {
		const { runtime } = harness();
		const first = runtime.sendMessage("slow please");
		// 等它真的跑起来
		await waitFor(() => runtime.isBusy());
		const second = await runtime.sendMessage("again");
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.code).toBe("session.busy");

		await first;
		expect(runtime.isBusy()).toBe(false);
	});

	it("中断：慢速回合被停下并给出中断提示", async () => {
		const { runtime, recorder: rec } = harness();
		rec.reset();
		const turn = runtime.sendMessage("slow please");
		await waitFor(() => runtime.isBusy());
		const result = await runtime.interrupt();
		expect(result.ok).toBe(true);
		await turn;

		expect(runtime.snapshot().running.status).toBe("idle");
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("中断"))).toBe(true);
	});

	it("空闲时中断被拒（不制造假状态）", async () => {
		const { runtime } = harness();
		const result = await runtime.interrupt();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("session.idle");
	});
});

describe("审批三态（ADR-0006）", () => {
	/**
	 * 发起一个会要求审批的回合，并等弹窗出现在状态里。
	 * ⚠️ 必须返回**对象**而不是那个 promise：async 函数 `return promise` 会被自动链化，
	 * 于是 `await startApprovalTurn()` 会一直等到回合结束 —— 而死锁就在那里（测试里踩过一次）。
	 */
	async function startApprovalTurn(runtime: Runtime) {
		const done = runtime.sendMessage("approve please");
		await waitFor(() => runtime.snapshot().pendingApproval !== null);
		return { done };
	}

	it("允许一次：弹窗在快照里可见，决定回传后回合继续", async () => {
		const { runtime } = harness();
		const { done } = await startApprovalTurn(runtime);
		const approval = runtime.snapshot().pendingApproval;
		expect(approval).toMatchObject({ toolName: "write_file" });
		expect(runtime.snapshot().running.status).toBe("awaiting_approval");

		const result = runtime.approve(approval!.requestId, "once");
		expect(result.ok).toBe(true);
		await done;

		expect(runtime.snapshot().pendingApproval).toBeNull();
		expect(assistantText(runtime.snapshot())).toContain("审批结果：once");
	});

	it("拒绝：引擎收到 deny 并收手", async () => {
		const { runtime } = harness();
		const { done } = await startApprovalTurn(runtime);
		runtime.approve(runtime.snapshot().pendingApproval!.requestId, "deny");
		await done;
		expect(assistantText(runtime.snapshot())).toContain("审批结果：deny");
	});

	it("总是允许这类：第二次同类操作不再问（本次运行内）", async () => {
		const { runtime, recorder: rec } = harness();
		const { done } = await startApprovalTurn(runtime);
		runtime.approve(runtime.snapshot().pendingApproval!.requestId, "always");
		await done;

		rec.reset();
		await runtime.sendMessage("approve again");
		const askedAgain = rec.snapshots.some((snapshot) => snapshot.pendingApproval !== null);
		expect(askedAgain).toBe(false);
		expect(assistantText(runtime.snapshot())).toContain("审批结果：always");
	});

	it("未知审批 id 被拒（不会误放行）", async () => {
		const { runtime } = harness();
		const result = runtime.approve("nope", "once");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("approval.unknown_request");
	});
});

describe("notice 去重（ADR-0013）", () => {
	it("同一错误在窗口内只提示一次", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("boom");
		await runtime.sendMessage("boom");
		const errors = runtime.snapshot().notices.filter((notice) => notice.level === "error");
		expect(errors).toHaveLength(1);
	});
});

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
		await waitFor(() => runtime.isBusy());

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

// 小工具：测试里造消息用（避免直接依赖后端模块的导入顺序）
function createMessageForTest(id: string, role: "user" | "assistant", ts: number) {
	return { id, role, ts, blocks: [] as import("../../server/protocol.js").MessageBlock[] };
}

function appendTextForTest(
	message: {
		id: string;
		role: "user" | "assistant";
		ts: number;
		blocks: import("../../server/protocol.js").MessageBlock[];
	},
	text: string,
) {
	return { ...message, blocks: [...message.blocks, { kind: "text" as const, text }] };
}

function messageTextForTest(snapshot: Snapshot): string {
	return snapshot.active.messages
		.flatMap((message) => message.blocks)
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("");
}
