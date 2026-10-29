/**
 * 流式正文追加的**两处实现必须一致**（`web/src/lib/delta.ts` 与 `server/snapshot/messages.ts`）。
 *
 * `delta.ts` 的文件头就写着「单测 `tests/unit/delta.test.ts` 锁住两者的行为一致性」，
 * 但这个文件一直不存在 —— 两边悄悄分叉时前端会出现「同一段文字重复/丢失」，
 * 而且只在长回复（多块）时才显形。这里把契约直接写成断言。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendText as appendServer } from "../../server/snapshot/messages.js";
import { appendTextToMessage } from "../../web/src/lib/delta.ts";
import type { MessageBlock } from "../../web/src/types.ts";

/** 两边共用的最小消息形状（字段够用即可，只比 blocks） */
const message = (blocks: MessageBlock[]) => ({ id: "m1", role: "assistant", createdAt: 0, blocks }) as never;

const cases: Array<{ name: string; blocks: MessageBlock[] }> = [
	{ name: "空消息 → 新建一个 text 块", blocks: [] },
	{ name: "末尾是 text → 就地追加", blocks: [{ kind: "text", text: "你好" }] },
	{
		name: "末尾是 tool → 另起一个 text 块",
		blocks: [
			{ kind: "text", text: "先说" },
			{ kind: "tool", toolCallId: "t1", name: "read", argsSummary: "" } as never,
		],
	},
	{ name: "末尾是 thinking → 另起一个 text 块", blocks: [{ kind: "thinking", text: "想一想" } as never] },
];

describe("appendText 两端一致性", () => {
	for (const item of cases) {
		it(item.name, () => {
			const server = appendServer(message(item.blocks), "追加");
			const web = appendTextToMessage(message(item.blocks), "追加");
			assert.deepEqual(web.blocks, server.blocks);
		});
	}

	it("连续追加不改变已有块的数量（就地累加）", () => {
		let current = appendTextToMessage(message([]), "a");
		current = appendTextToMessage(current, "b");
		current = appendTextToMessage(current, "c");
		assert.equal(current.blocks.length, 1);
		assert.equal(current.blocks[0]?.kind, "text");
		assert.equal(current.blocks[0]?.kind === "text" ? current.blocks[0].text : "", "abc");
	});

	it("不改原对象（纯函数）", () => {
		const original = message([{ kind: "text", text: "x" }]);
		const next = appendTextToMessage(original, "y");
		assert.notEqual(next, original);
		const first = original.blocks[0];
		assert.equal(first?.kind === "text" ? first.text : "", "x");
	});
});
