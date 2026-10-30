/**
 * 快照结构共享（`web/src/snapshot-share.ts`）的契约。
 *
 * 这个函数是前端所有 memo 的地基：它一变「偷偷总是返回新对象」，
 * `memo(MessageView)` / `memo(Sidebar)` 就全体失效，表现是「流式时整屏重渲染 + Markdown 重解析」——
 * 而功能上一切正常、没有断言会失败。所以引用复用必须被单测钉死。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shareSnapshot } from "../../web/src/snapshot-share.ts";

const snapshot = (text: string) => ({
	active: {
		conversationId: "c1",
		messages: [
			{ id: "m1", role: "assistant", blocks: [{ kind: "text", text: "第一句" }] },
			{ id: "m2", role: "assistant", blocks: [{ kind: "text", text }] },
		],
	},
	conversations: [{ id: "c1", title: "对话" }],
	settings: { sessionPrefs: { pinned: ["c1"], archived: [] as string[], order: [] } },
});

describe("shareSnapshot：内容没变的部分必须沿用旧引用", () => {
	it("整份不变 → 直接返回上一份", () => {
		const previous = snapshot("第二句");
		const next = snapshot("第二句");
		assert.notEqual(previous, next); // 前提：确实是两份新对象
		assert.equal(shareSnapshot(previous, next), previous);
	});

	it("只有一条消息变 → 别的消息对象引用不变（memo 才救得下来）", () => {
		const previous = snapshot("旧回答");
		const next = snapshot("新回答");
		const merged = shareSnapshot(previous, next);

		assert.notEqual(merged, previous); // 这条路径变了
		assert.notEqual(merged.active.messages, previous.active.messages);
		assert.equal(merged.active.messages[0], previous.active.messages[0]); // 没变的消息复用
		assert.notEqual(merged.active.messages[1], previous.active.messages[1]); // 变了的那条换新
		assert.equal(merged.conversations, previous.conversations); // 旁支整块复用
		assert.equal(merged.settings, previous.settings);
	});

	it("数组长度变了 → 给新数组（不能拿旧的凑）", () => {
		const previous = snapshot("a");
		const next = snapshot("a");
		next.active.messages.push({ id: "m3", role: "user", blocks: [] });
		const merged = shareSnapshot(previous, next);
		assert.equal(merged.active.messages.length, 3);
		assert.notEqual(merged.active.messages, previous.active.messages);
	});

	it("对象多了/少了键 → 视为变化，不误判为相等", () => {
		const previous = snapshot("a");
		const next = snapshot("a") as ReturnType<typeof snapshot> & { extra?: string };
		next.extra = "新字段";
		const merged = shareSnapshot(previous, next) as typeof next;
		assert.equal(merged.extra, "新字段");
	});

	it("没有上一份（首次连接 / 换了连接）→ 原样返回新快照", () => {
		const next = snapshot("a");
		assert.equal(shareSnapshot(null, next), next);
		assert.equal(shareSnapshot(undefined, next), next);
	});
});
