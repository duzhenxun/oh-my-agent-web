/**
 * 前端「流式追加」与服务端同一规则的一致性（ADR-0004 §3 的两处实现）。
 *
 * 前端之所以要自己追加一次：正文走 message_delta 增量，客户端必须能就地更新，
 * 不能每字等一次全量快照。这条测试锁住两份实现的行为一致，防止它们各自漂移。
 */
import { describe, expect, it } from "vitest";
import { appendText } from "../../server/snapshot/messages.js";
import { createMessage } from "../../server/snapshot/messages.js";
import { appendTextToMessage } from "../../web/src/lib/delta.ts";

function runOn(server: boolean) {
	const steps = ["第一", "段", undefined, "第二段"] as const;
	let message = createMessage("m1", "assistant", 0);
	for (const step of steps) {
		if (step === undefined) {
			// 中间插入一个非文本块（模拟工具卡），两侧实现都必须「另起一个文本块」
			message = {
				...message,
				blocks: [
					...message.blocks,
					{
						kind: "tool",
						toolCallId: "t1",
						name: "read_file",
						argsSummary: "a",
						status: "running",
						outputExcerpt: "",
						truncated: false,
						startedAt: 1,
					},
				],
			};
			continue;
		}
		message = server ? appendText(message, step) : appendTextToMessage(message, step);
	}
	return message;
}

describe("流式追加：前端与服务端同规则", () => {
	it("两种情况（拼接 / 另起块）结果完全一致", () => {
		expect(runOn(false)).toEqual(runOn(true));
	});

	it("连续追加会拼在同一个文本块里", () => {
		let message = createMessage("m1", "assistant", 0);
		message = appendTextToMessage(message, "a");
		message = appendTextToMessage(message, "b");
		expect(message.blocks).toEqual([{ kind: "text", text: "ab" }]);
	});

	it("工具块之后另起一个新的文本块", () => {
		let message = createMessage("m1", "assistant", 0);
		message = appendTextToMessage(message, "a");
		message = {
			...message,
			blocks: [...message.blocks, { kind: "error", code: "x", message: "y" }],
		};
		message = appendTextToMessage(message, "b");
		expect(message.blocks.map((block) => block.kind)).toEqual(["text", "error", "text"]);
	});
});
