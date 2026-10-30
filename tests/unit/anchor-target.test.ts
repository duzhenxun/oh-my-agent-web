/**
 * 「发出去的消息要不要顶到视口上方」（`web/src/anchor-target.ts`）。
 *
 * 这段判断踩过两次坑，两次都是「看起来该顶，但没顶」：
 *   1. 按「末尾是不是 user」判断 → 服务端一发出就插 assistant 占位，永远判不中；
 *   2. 只盯 `messages` 里的用户消息 → **点建议按钮 / 快捷短语**发出去的那条先落进
 *      `queued`（排队项），压根不在 `messages` 里，于是它一直贴在输入框上方不动
 *      （用户 2026-10-30：「不像我手动回车那样发到上面去」）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextAnchorTarget, type AnchorSeen } from "../../web/src/anchor-target.ts";

const seen = (patch: Partial<AnchorSeen> = {}): AnchorSeen => ({
	conversation: "c1",
	messageId: "u1",
	queuedId: null,
	...patch,
});

const current = (patch: Partial<AnchorSeen> = {}): AnchorSeen => seen(patch);

describe("nextAnchorTarget", () => {
	it("刚发出一条用户消息 → 顶它", () => {
		const result = nextAnchorTarget(seen(), current({ messageId: "u2" }));
		assert.equal(result.target, "u2");
		assert.equal(result.seen.messageId, "u2");
	});

	it("点建议按钮 / 快捷短语（这一轮在跑，消息先排队）→ 也要顶排队项", () => {
		const result = nextAnchorTarget(seen(), current({ queuedId: "q1" }));
		assert.equal(result.target, "q1");
	});

	it("排队项解除、真消息进来 → 顶真消息（不是排队项）", () => {
		const result = nextAnchorTarget(seen({ queuedId: "q1" }), current({ messageId: "u2", queuedId: null }));
		assert.equal(result.target, "u2");
	});

	it("什么都没变（只是重渲染 / 流式吐字）→ 不动", () => {
		assert.equal(nextAnchorTarget(seen(), current()).target, null);
	});

	it("换会话 → 只记账不锚（打开旧会话应该落在最新进度）", () => {
		const result = nextAnchorTarget(seen(), current({ conversation: "c2", messageId: "u9" }));
		assert.equal(result.target, null);
		assert.equal(result.seen.conversation, "c2");
		assert.equal(result.seen.messageId, "u9");
	});

	it("第一次挂载（没有上一帧）→ 不锚", () => {
		const result = nextAnchorTarget(
			{ conversation: null, messageId: null, queuedId: null },
			{ conversation: "c1", messageId: "u1", queuedId: null },
		);
		assert.equal(result.target, null);
	});

	it("排队项被撤掉（queuedId 变 null）→ 不当成新消息去顶", () => {
		assert.equal(nextAnchorTarget(seen({ queuedId: "q1" }), current({ queuedId: null })).target, null);
	});
});
