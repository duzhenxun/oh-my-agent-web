/**
 * 消息块的纯函数工具（ADR-0012：消息由块构成）。
 *
 * 全部是纯函数（不改入参），便于单测覆盖「文本追加 / 工具卡状态流转 / 摘录截断」。
 */
import { TOOL_EXCERPT_CHARS, type MessageBlock, type ToolBlock, type UiMessage } from "../protocol.js";

export function createMessage(id: string, role: UiMessage["role"], ts: number): UiMessage {
	return { id, role, ts, blocks: [] };
}

/** 追加文本：接到最后一个文本块后面（保持「说一句 → 调工具 → 再说一句」的交错顺序） */
export function appendText(message: UiMessage, text: string): UiMessage {
	const blocks = [...message.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
	else blocks.push({ kind: "text", text });
	return { ...message, blocks };
}

export function startTool(
	message: UiMessage,
	input: { toolCallId: string; name: string; argsSummary: string; startedAt: number },
): UiMessage {
	const block: ToolBlock = {
		kind: "tool",
		toolCallId: input.toolCallId,
		name: input.name,
		argsSummary: input.argsSummary,
		status: "running",
		outputExcerpt: "",
		truncated: false,
		startedAt: input.startedAt,
	};
	return { ...message, blocks: [...message.blocks, block] };
}

/** 摘录预算（ADR-0004 §5）：超限截断并打标记，而不是把 200KB 塞进快照 */
export function truncateExcerpt(
	output: string,
	limit = TOOL_EXCERPT_CHARS,
): { outputExcerpt: string; truncated: boolean } {
	if (output.length <= limit) return { outputExcerpt: output, truncated: false };
	return { outputExcerpt: output.slice(0, limit), truncated: true };
}

export function finishTool(
	message: UiMessage,
	input: { toolCallId: string; status: ToolBlock["status"]; output: string; exitCode?: number; endedAt: number },
): UiMessage {
	const { outputExcerpt, truncated } = truncateExcerpt(input.output);
	const blocks = message.blocks.map((block): MessageBlock => {
		if (block.kind !== "tool" || block.toolCallId !== input.toolCallId) return block;
		return {
			...block,
			status: input.status,
			outputExcerpt,
			truncated,
			endedAt: input.endedAt,
			...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
		};
	});
	return { ...message, blocks };
}

export function appendError(message: UiMessage, code: string, text: string): UiMessage {
	return { ...message, blocks: [...message.blocks, { kind: "error", code, message: text }] };
}

/** 快照里最后一条消息的纯文本（给状态栏/调试用） */
export function messageText(message: UiMessage): string {
	return message.blocks
		.map((block) =>
			block.kind === "text" ? block.text : block.kind === "error" ? `[${block.code}] ${block.message}` : "",
		)
		.join("");
}

/** 追加思考文本（与正文分开：正文说结论，思考说过程） */
export function appendThinking(message: UiMessage, text: string): UiMessage {
	const blocks = [...message.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.kind === "thinking") blocks[blocks.length - 1] = { kind: "thinking", text: last.text + text };
	else blocks.push({ kind: "thinking", text });
	return { ...message, blocks };
}
