/**
 * 右侧临时聊天的通道状态机（`web/src/side-chat.ts` 的 `applySideFrame`）。
 *
 * 这条通道是**第二条连接**，坏一帧不能把右侧整块面板带崩，所以这里锁：
 *   1. 整份快照直接换；增量只往「这一条会话」里追加；
 *   2. 别的会话的增量丢掉（多标签共用 clientId 时会出现）；
 *   3. 请求被拒记成一句提示，快照不动。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySideFrame, type SideState } from "../../web/src/side-chat.ts";
import type { Snapshot, UiMessage } from "../../web/src/types.ts";

const message = (id: string, text: string): UiMessage => ({
	id,
	role: "assistant",
	ts: 1,
	blocks: [{ kind: "text", text }],
});

const snapshotOf = (conversationId: string, messages: UiMessage[]): Snapshot =>
	({
		active: { conversationId, messages, hasMoreBefore: false },
		running: { status: "idle", conversationId: null },
	}) as unknown as Snapshot;

describe("side-chat 通道", () => {
	const empty: SideState = { snapshot: null, error: null };

	it("快照帧直接换掉状态", () => {
		const next = applySideFrame(empty, { type: "event", event: "snapshot", snapshot: snapshotOf("c1", []) });
		assert.equal(next.snapshot?.active.conversationId, "c1");
	});

	it("快照帧不会冲掉预填的草稿（「在临时聊天中提问」塞进来的引用块）", () => {
		const withDraft: SideState = { snapshot: null, error: null, draft: "> 引用\n\n" };
		const next = applySideFrame(withDraft, { type: "event", event: "snapshot", snapshot: snapshotOf("c1", []) });
		assert.equal(next.draft, "> 引用\n\n");
		assert.equal(next.snapshot?.active.conversationId, "c1");
	});

	it("增量追加到同一条会话的正文末尾", () => {
		const state = applySideFrame(empty, {
			type: "event",
			event: "snapshot",
			snapshot: snapshotOf("c1", [message("m1", "你")]),
		});
		const next = applySideFrame(state, {
			type: "event",
			event: "message_delta",
			conversationId: "c1",
			messageId: "m1",
			text: "好",
		});
		assert.deepEqual(next.snapshot?.active.messages[0].blocks, [{ kind: "text", text: "你好" }]);
	});

	it("别的会话 / 不认识的帧一律不动", () => {
		const state = applySideFrame(empty, {
			type: "event",
			event: "snapshot",
			snapshot: snapshotOf("c1", [message("m1", "x")]),
		});
		const other = applySideFrame(state, {
			type: "event",
			event: "message_delta",
			conversationId: "c2",
			messageId: "m1",
			text: "y",
		});
		assert.equal(other, state);
		assert.equal(applySideFrame(state, { type: "event", event: "notice", notice: {} }), state);
		assert.equal(applySideFrame(state, null), state);
		assert.equal(applySideFrame(state, "乱码"), state);
	});

	it("请求被拒只记一句提示，快照保住", () => {
		const state = applySideFrame(empty, {
			type: "event",
			event: "snapshot",
			snapshot: snapshotOf("c1", []),
		});
		const next = applySideFrame(state, { type: "reply", ok: false, error: { code: "engine.busy", message: "忙" } });
		assert.equal(next.snapshot?.active.conversationId, "c1");
		assert.match(next.error ?? "", /engine\.busy/);
	});
});
