/**
 * 「正在重试」显示在哪、什么时候消失（`server/session/turn-events.ts`）。
 *
 * 用户的要求：模型连接被打断（`engine.provider_error: This operation was aborted` 那类）时
 * 引擎会自己再试一次，**界面上得看得见「正在重试」**，不能让它像卡死一样静着。
 *
 * 规则：
 *   · `retry` 事件 → 写进 `state.running.retrying`（界面用它把「正在等待模型…」换成「正在重试…」）；
 *   · 下一次尝试真的开始吐字 / 调工具（或回合收尾）→ 清掉；
 *   · `usage` / `model` / `notice` 这类过程事件不该把它清掉（它们不是「重新开始了」）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineEvent } from "../../server/engine/port.ts";
import { applyEngineEvent, createTurnContext } from "../../server/session/turn-events.ts";
import { createServerState } from "../../server/snapshot/state.ts";

const MESSAGE_ID = "m-1";

function harness() {
	const state = createServerState("/w");
	state.activeId = "conv-a";
	state.running = {
		status: "streaming",
		conversationId: "conv-a",
		turnStartedAt: 1_000,
		streamingText: "",
		activeTool: null,
		retrying: null,
	};
	state.messages["conv-a"] = [
		{ id: MESSAGE_ID, role: "assistant", ts: 1_000, blocks: [{ kind: "text", text: "" }] } as never,
	];
	const snapshots: number[] = [];
	const notices: Array<{ text: string; conversationId?: string }> = [];
	let now = 1_000;
	const context = createTurnContext({
		state,
		now: () => (now += 10),
		pushSnapshot: () => snapshots.push(now),
		emitEvent: () => {},
		notice: (text, _level, _key, conversationId) => notices.push({ text, conversationId }),
		onThinkingDelta: () => {},
		appendRawText: (chunk) => chunk,
		finish: () => {},
	});
	const apply = (event: EngineEvent) =>
		applyEngineEvent(context, { conversationId: "conv-a", messageId: MESSAGE_ID, event });
	return { state, apply, snapshots, notices };
}

describe("retry 事件 → 「正在重试」", () => {
	it("写进 running.retrying，并推一帧快照", () => {
		const { state, apply, snapshots } = harness();
		apply({ type: "retry", attempt: 1, maxAttempts: 2 });
		assert.deepEqual(state.running.retrying, { attempt: 1, maxAttempts: 2 });
		assert.equal(snapshots.length, 1);
	});

	it("下一次尝试开始吐字 → 清掉", () => {
		const { state, apply } = harness();
		apply({ type: "retry", attempt: 1, maxAttempts: 2 });
		apply({ type: "text_delta", text: "好" });
		assert.equal(state.running.retrying, null);
	});

	it("开始调工具 → 也清掉（重试成功了，模型已经动起来了）", () => {
		const { state, apply } = harness();
		apply({ type: "retry", attempt: 1, maxAttempts: 2 });
		apply({ type: "tool_start", toolCallId: "t1", name: "bash", argsSummary: "ls" });
		assert.equal(state.running.retrying, null);
	});

	it("usage / model / notice 这类过程事件不动它（退避期间这些照旧在飞）", () => {
		const { state, apply } = harness();
		apply({ type: "retry", attempt: 1, maxAttempts: 2 });
		apply({ type: "usage", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
		apply({ type: "model", model: "deepseek/deepseek-flash" });
		apply({ type: "notice", level: "info", text: "随便一条" });
		assert.deepEqual(state.running.retrying, { attempt: 1, maxAttempts: 2 });
	});

	it("notice 事件按会话归位（不是全局提示）", () => {
		const { apply, notices } = harness();
		apply({ type: "notice", level: "info", text: "模型调用已自动恢复（重试 1 次）", key: "engine-retry:conv-a" });
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.conversationId, "conv-a");
	});
});

/**
 * 「客户端看的不是全局那条会话」时，流式正文 / 工具卡 / 重试提示也得看得见。
 *
 * 用户 2026-10-30：「跑着跑着，我发的话跟当前 agent 的思考、工具调用信息都看不到了」。
 * 根因之一：这些东西以前只记在**全局一份** `state.running` 上，而且只在
 * `conversationId === state.activeId` 时累加；客户端自己的视角是另一条会话（并行回合、
 * 多标签、全局 activeId 被别的客户端改走）时，快照只能把它们全置空。
 *
 * 现在每个会话各记一份（`runningByConversation`），看谁就给谁那份。
 */
function perConversationHarness() {
	const state = createServerState("/w");
	state.activeId = "conv-b"; // 全局 activeId 早就飘到别的会话了
	state.running = {
		status: "streaming",
		conversationId: "conv-b",
		turnStartedAt: 1_000,
		streamingText: "",
		activeTool: null,
		retrying: null,
	};
	state.messages["conv-a"] = [
		{ id: MESSAGE_ID, role: "assistant", ts: 1_000, blocks: [{ kind: "text", text: "" }] } as never,
	];
	state.runningByConversation = { "conv-a": { status: "streaming", turnStartedAt: 1_000, streamingText: "" } };
	const context = createTurnContext({
		state,
		now: () => 1_100,
		pushSnapshot: () => {},
		emitEvent: () => {},
		notice: () => {},
		onThinkingDelta: () => {},
		appendRawText: (chunk) => chunk,
		finish: () => {},
	});
	const apply = (event: EngineEvent) =>
		applyEngineEvent(context, { conversationId: "conv-a", messageId: MESSAGE_ID, event });
	return { state, apply };
}

describe("流式正文 / 工具 / 重试按会话各记一份", () => {
	it("不是全局 activeId 的会话，吐字仍然记进它自己那份", () => {
		const { state, apply } = perConversationHarness();
		apply({ type: "text_delta", text: "你" });
		apply({ type: "text_delta", text: "好" });
		assert.equal(state.runningByConversation["conv-a"]?.streamingText, "你好");
		assert.equal(state.running.streamingText, "", "全局那份不该被别人的会话写进去");
	});

	it("工具开始 / 结束都记进它自己那份", () => {
		const { state, apply } = perConversationHarness();
		apply({ type: "tool_start", toolCallId: "t1", name: "bash", argsSummary: "ls -la" });
		assert.equal(state.runningByConversation["conv-a"]?.activeTool?.name, "bash");
		apply({ type: "tool_end", toolCallId: "t1", status: "ok", output: "done" });
		assert.equal(state.runningByConversation["conv-a"]?.activeTool, null);
	});

	it("重试提示也按会话记（别人的会话不该看到）", () => {
		const { state, apply } = perConversationHarness();
		apply({ type: "retry", attempt: 1, maxAttempts: 3 });
		assert.deepEqual(state.runningByConversation["conv-a"]?.retrying, { attempt: 1, maxAttempts: 3 });
		apply({ type: "text_delta", text: "继续" });
		assert.equal(state.runningByConversation["conv-a"]?.retrying, null);
	});
});
