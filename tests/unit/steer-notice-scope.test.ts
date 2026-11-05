/**
 * 插队 / 排队 / 取消插队的提示必须带上「所属会话」。
 *
 * 以前这些提示是全局的：临时聊天里点的「已插队」会冒到左边正式会话的输入框上方。
 * 带上 conversationId 后，界面按会话过滤（NoticeBar），只在对应那一栏显示。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelQueuedWith, createTurnPlumbing } from "../../server/session/turn-queue.ts";

type Notice = { text: string; conversationId?: string };

function harness() {
	const notices: Notice[] = [];
	const state = { activeId: "main", queued: [] as { id: string; conversationId: string; mode: string }[] };
	let seq = 0;
	const plumbing = createTurnPlumbing({
		state: state as never,
		engine: { sendMessage: async () => {} } as never,
		nextId: (prefix: string) => `${prefix}-${++seq}`,
		appendUser: () => {},
		notice: (text: string, _level: "info" | "warn", conversationId?: string) =>
			void notices.push({ text, ...(conversationId ? { conversationId } : {}) }),
		pushSnapshot: () => {},
		isTurnRunning: () => true,
	});
	return { plumbing, state, notices };
}

test("插队的提示挂在发起插队的那个会话上（不是全局）", async () => {
	const h = harness();
	await h.plumbing.busy("steer", "hi", "hi", [], "side-chat-1");
	const steer = h.notices.find((notice) => notice.text.startsWith("已插队"));
	assert.ok(steer, "应该有一条「已插队」提示");
	assert.equal(steer.conversationId, "side-chat-1");
});

test("排队的提示也挂在对应会话上", async () => {
	const h = harness();
	await h.plumbing.busy("queue", "hi", "hi", [], "side-chat-2");
	const queued = h.notices.find((notice) => notice.text.startsWith("已排队"));
	assert.equal(queued?.conversationId, "side-chat-2");
});

test("取消插队的提示沿用被取消那一条所属的会话", async () => {
	const h = harness();
	await h.plumbing.busy("steer", "bye", "bye", [], "side-chat-3");
	const queueId = h.state.queued[0]?.id;
	assert.ok(queueId, "插队应该已挂进队列");
	const result = cancelQueuedWith(h.plumbing.queue, queueId, (text, level, conversationId) => {
		h.notices.push({ text, ...(conversationId ? { conversationId } : {}) });
	});
	assert.equal(result.ok, true);
	const cancelled = h.notices.find((notice) => notice.text.startsWith("已取消插队"));
	assert.equal(cancelled?.conversationId, "side-chat-3");
});
