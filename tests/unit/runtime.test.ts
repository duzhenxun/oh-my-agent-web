/**
 * 运行时单测（M1 部分）：回合、工具卡、审批三态、notice 去重。
 * 存储与规则相关（M2/M3）在 runtime-session.test.ts；共用夹具在 helpers/runtime-harness.ts。
 */
import { describe, expect, it } from "vitest";
import { TOOL_EXCERPT_CHARS } from "../../server/protocol.js";
import type { Runtime } from "../../server/session/runtime.js";
import { assistantText, harness, waitFor } from "./helpers/runtime-harness.js";

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
