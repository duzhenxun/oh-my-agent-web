/**
 * 历史回放里「工具卡应该显示成什么状态」。
 *
 * 背景：用户报「有时莫名其妙就卡住了」，截图里是两个 bash 显示「完成」、没有任何输出，
 * 也没有下文。真相不是模型卡住，而是**服务在工具执行中途被重启**（dev 的
 * `tsx --watch` 改文件就重启 / `aw restart`）：pi 的会话文件里只落了带 toolCall 的
 * 助手消息，toolResult 那条根本没来得及写。以前这种悬空的调用默认按 `ok` 渲染，
 * 界面上就成了「跑完了，但什么也没做」——比报错更让人困惑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entriesToUiMessages } from "../../server/engine/pi-transcript.ts";
import type { ToolBlock, UiMessage } from "../../server/protocol.ts";

const ts = 1793329130000;

function assistantWithBashCall(id: string, command: string) {
	return {
		type: "message",
		id: "entry-call",
		timestamp: ts,
		message: {
			role: "assistant",
			stopReason: "toolUse",
			timestamp: ts,
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		},
	};
}

function toolResult(id: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		type: "message",
		id: "entry-result",
		timestamp: ts + 1000,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			timestamp: ts + 1000,
			content: [{ type: "text", text }],
			...extra,
		},
	};
}

function toolBlocks(messages: UiMessage[]): ToolBlock[] {
	return messages.flatMap((message) => message.blocks.filter((block): block is ToolBlock => block.kind === "tool"));
}

describe("pi 会话回放：工具卡状态", () => {
	it("有调用没结果（服务重启把这一轮带走了）→ failed，不是 ok、也不会一直转圈", () => {
		const blocks = toolBlocks(entriesToUiMessages([assistantWithBashCall("t1", "ls")]));
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.status, "failed");
		assert.equal(blocks[0]!.outputExcerpt, "");
	});

	it("同一轮里两条悬空调用都收口（截图里那种两条 bash 的情况）", () => {
		const entry = assistantWithBashCall("t1", "ls");
		const message = entry.message as Record<string, unknown>;
		message.content = [
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "pwd" } },
		];
		const blocks = toolBlocks(entriesToUiMessages([entry]));
		assert.deepEqual(
			blocks.map((block) => block.status),
			["failed", "failed"],
		);
	});

	it("有结果的照旧回填 ok + 输出 + 退出码", () => {
		const blocks = toolBlocks(
			entriesToUiMessages([
				assistantWithBashCall("t1", "ls"),
				toolResult("t1", "file.txt", { details: { exitCode: 0 } }),
			]),
		);
		assert.equal(blocks[0]!.status, "ok");
		assert.equal(blocks[0]!.outputExcerpt, "file.txt");
		assert.equal(blocks[0]!.exitCode, 0);
	});

	it("结果报错 → failed（跟悬空调用是两回事，别混为一谈）", () => {
		const blocks = toolBlocks(
			entriesToUiMessages([assistantWithBashCall("t1", "boom"), toolResult("t1", "炸了", { isError: true })]),
		);
		assert.equal(blocks[0]!.status, "failed");
		assert.equal(blocks[0]!.outputExcerpt, "炸了");
	});

	it("live（这一轮还在跑）→ 保持 running，不许提前判死", () => {
		const blocks = toolBlocks(entriesToUiMessages([assistantWithBashCall("t1", "ls")], { live: true }));
		assert.equal(blocks[0]!.status, "running");
	});
});
