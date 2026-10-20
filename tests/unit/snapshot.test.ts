import { describe, expect, it } from "vitest";
import { TOOL_EXCERPT_CHARS, type UiMessage } from "../../server/protocol.js";
import { appendError, appendText, createMessage, finishTool, startTool } from "../../server/snapshot/messages.js";
import { buildSnapshot, createConversation, createServerState, snapshotBytes } from "../../server/snapshot/state.js";

describe("消息块助手（ADR-0012）", () => {
	it("文本追加接到最后一个文本块后面（保持与工具卡的交错顺序）", () => {
		let message = createMessage("m1", "assistant", 0);
		message = appendText(message, "第一句");
		message = appendText(message, "接着");
		message = startTool(message, { toolCallId: "t1", name: "read_file", argsSummary: "a.ts", startedAt: 1 });
		message = appendText(message, "第二句");

		expect(message.blocks.map((block) => block.kind)).toEqual(["text", "tool", "text"]);
		expect((message.blocks[0] as { text: string }).text).toBe("第一句接着");
	});

	it("工具卡状态流转：running → ok/failed，并带退出码", () => {
		let message = createMessage("m1", "assistant", 0);
		message = startTool(message, { toolCallId: "t1", name: "run_command", argsSummary: "npm test", startedAt: 1 });
		expect((message.blocks[0] as { status: string }).status).toBe("running");

		message = finishTool(message, { toolCallId: "t1", status: "failed", output: "boom", exitCode: 1, endedAt: 2 });
		const tool = message.blocks[0] as { status: string; exitCode?: number; endedAt?: number };
		expect(tool.status).toBe("failed");
		expect(tool.exitCode).toBe(1);
		expect(tool.endedAt).toBe(2);
	});

	it("超大输出被截断并打标记（ADR-0004 §5）", () => {
		let message = createMessage("m1", "assistant", 0);
		message = startTool(message, { toolCallId: "t1", name: "run_command", argsSummary: "cat big", startedAt: 1 });
		message = finishTool(message, {
			toolCallId: "t1",
			status: "ok",
			output: "x".repeat(TOOL_EXCERPT_CHARS * 3),
			endedAt: 2,
		});
		const tool = message.blocks[0] as { outputExcerpt: string; truncated: boolean };
		expect(tool.truncated).toBe(true);
		expect(tool.outputExcerpt).toHaveLength(TOOL_EXCERPT_CHARS);
	});

	it("错误块进消息（失败必须留在历史里，ADR-0013）", () => {
		const message = appendError(createMessage("m1", "assistant", 0), "engine.timeout", "超时");
		expect(message.blocks[0]).toEqual({ kind: "error", code: "engine.timeout", message: "超时" });
	});

	it("不修改传入的消息（纯函数）", () => {
		const original = createMessage("m1", "assistant", 0);
		const next = appendText(original, "x");
		expect(original.blocks).toHaveLength(0);
		expect(next.blocks).toHaveLength(1);
	});
});

describe("快照构造（ADR-0012）", () => {
	function stateWithMessages(count: number) {
		const state = createServerState("/tmp/ws");
		const conversation = createConversation({ id: "c1", title: "t", workspace: state.workspace, now: 0 });
		state.conversations = [conversation];
		state.activeId = "c1";
		state.messages.c1 = Array.from({ length: count }, (_, index) =>
			appendText(createMessage(`m${index}`, "user", index), `第 ${index} 条`),
		);
		return state;
	}

	it("只保留最近 N 条，并标出 hasMoreBefore", () => {
		const snapshot = buildSnapshot(stateWithMessages(150));
		expect(snapshot.active.messages).toHaveLength(100);
		expect(snapshot.active.hasMoreBefore).toBe(true);
		expect(snapshot.active.messages[0].id).toBe("m50");
	});

	it("不足 N 条时不标 hasMoreBefore", () => {
		const snapshot = buildSnapshot(stateWithMessages(3));
		expect(snapshot.active.messages).toHaveLength(3);
		expect(snapshot.active.hasMoreBefore).toBe(false);
	});

	it("同一份 state 得到同一份快照（幂等：丢帧后仍能收敛）", () => {
		const state = stateWithMessages(5);
		expect(buildSnapshot(state)).toEqual(buildSnapshot(state));
	});

	it("返回的是副本：改快照不会污染服务端状态", () => {
		const state = stateWithMessages(1);
		const snapshot = buildSnapshot(state);
		snapshot.running.streamingText = "被改了";
		snapshot.active.messages[0].blocks.push({ kind: "text", text: "注入" });
		expect(state.running.streamingText).toBe("");
		expect(state.messages.c1[0].blocks).toHaveLength(1);
	});

	it("快照体积可测（体积护栏用）", () => {
		const bytes = snapshotBytes(buildSnapshot(stateWithMessages(20)));
		expect(bytes).toBeGreaterThan(100);
		expect(bytes).toBeLessThan(64 * 1024);
	});

	it("空状态也给出合法快照", () => {
		const snapshot = buildSnapshot(createServerState("/tmp/ws"));
		expect(snapshot.active.conversationId).toBeNull();
		expect(snapshot.active.messages).toEqual([]);
		expect(snapshot.pendingApproval).toBeNull();
	});
});

describe("运行时用的最小消息形状", () => {
	it("UiMessage 只有 id/role/ts/blocks", () => {
		const message: UiMessage = createMessage("m1", "user", 123);
		expect(Object.keys(message).sort()).toEqual(["blocks", "id", "role", "ts"]);
	});
});

describe("buildSnapshot：按客户端覆盖当前会话（ADR-0033）", () => {
	it("同一份 state，两个客户端拿到各自的 active", () => {
		const state = createServerState("/tmp/ws");
		state.activeId = "conv-a";
		state.messages["conv-a"] = [{ id: "m1", role: "user", ts: 1, blocks: [{ kind: "text", text: "A" }] }];
		state.messages["conv-b"] = [{ id: "m2", role: "user", ts: 2, blocks: [{ kind: "text", text: "B" }] }];

		const forA = buildSnapshot(state, undefined, "conv-a");
		const forB = buildSnapshot(state, undefined, "conv-b");
		expect(forA.active.conversationId).toBe("conv-a");
		expect(forB.active.conversationId).toBe("conv-b");
		expect(forB.active.messages[0]?.id).toBe("m2");
		// 不传覆盖值时仍用全局 activeId（老行为不变）
		expect(buildSnapshot(state).active.conversationId).toBe("conv-a");
	});
});
