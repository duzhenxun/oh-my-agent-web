/**
 * 打断之后工具卡必须收尾（ADR-0054 的收尾一致性）。
 *
 * 实测事实（codex-cli 0.171.0）：`turn/interrupt` 之后引擎直接给 `turn/completed`，
 * **不会**再补一个 `tool_end`。宿主如果不管，那个工具块就永远停在 `status: "running"`，
 * 界面上是一条永远转圈的 `bash sleep 12` —— 用户以为它还在跑，其实这一轮早结束了。
 *
 * 这里测 settleRunningTools 本身（纯函数），以及它对「已经结束的工具」不做任何改动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { settleRunningTools, startTool, finishTool } from "../../server/snapshot/messages.ts";
import type { UiMessage } from "../../server/protocol.ts";

function emptyMessage(): UiMessage {
	return { id: "m1", role: "assistant", at: 1, blocks: [] };
}

test("打断时还挂着的工具 → 补成 interrupted，并带一句人话说明", () => {
	const message = startTool(emptyMessage(), {
		toolCallId: "t1",
		name: "bash",
		argsSummary: "sleep 12",
		startedAt: 100,
	});
	const settled = settleRunningTools(message, { at: 5000, text: "这一步被打断了（没有执行完）" });
	const block = settled.blocks[0];
	assert.equal(block?.kind, "tool");
	if (block?.kind !== "tool") return;
	assert.equal(block.status, "interrupted");
	assert.equal(block.endedAt, 5000);
	assert.match(block.outputExcerpt, /打断/);
});

test("已经结束的工具不受影响（幂等：收尾跑两次结果一样）", () => {
	const done = finishTool(
		startTool(emptyMessage(), { toolCallId: "t1", name: "bash", argsSummary: "ls", startedAt: 100 }),
		{ toolCallId: "t1", status: "ok", output: "a.txt", endedAt: 200 },
	);
	const once = settleRunningTools(done, { at: 5000, text: "打断" });
	assert.equal(once, done, "没有 running 的块时应原样返回（引用都不变）");
	const twice = settleRunningTools(once, { at: 6000, text: "打断" });
	assert.equal(twice, once);
});

test("多个工具里只收掉还在跑的那个", () => {
	let message = startTool(emptyMessage(), { toolCallId: "t1", name: "bash", argsSummary: "ls", startedAt: 100 });
	message = finishTool(message, { toolCallId: "t1", status: "ok", output: "ok", endedAt: 200 });
	message = startTool(message, { toolCallId: "t2", name: "bash", argsSummary: "sleep 12", startedAt: 300 });

	const settled = settleRunningTools(message, { at: 5000, text: "这一步被打断了" });
	const [first, second] = settled.blocks;
	assert.equal(first?.kind === "tool" ? first.status : null, "ok", "先跑完的那个不能被我改掉");
	assert.equal(second?.kind === "tool" ? second.status : null, "interrupted");
});
