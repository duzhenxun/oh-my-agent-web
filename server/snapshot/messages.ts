/**
 * 消息块的纯函数工具（ADR-0012：消息由块构成）。
 *
 * 全部是纯函数（不改入参），「文本追加 / 工具卡状态流转 / 摘录截断」都只由入参决定结果。
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

/**
 * 用权威全文校正「这一段正文」（`text_end` 到达时调用，ADR-0004 §3 的兜底）。
 *
 * 只在两种情况下动手，其余一律原样返回（幂等、不会把别的正文写坏）：
 *   1. 尾部正文块是权威全文的**前缀** → 补全（典型：某个 delta 丢了，界面只剩半句 / 一个字）；
 *   2. 还没有尾部正文块（delta 全丢）→ 补一块。
 * 尾部是工具块时（text_end 之后紧跟 toolCall）也属于第 2 种：正文本来就该在工具块**之前**，
 * 这里不越过工具块去改历史，交给下一段正文正常追加。
 */
export function reconcileText(message: UiMessage, text: string): UiMessage {
	if (text === "") return message;
	const blocks = [...message.blocks];
	const last = blocks[blocks.length - 1];
	if (!last) return { ...message, blocks: [{ kind: "text", text }] };
	if (last.kind === "text") {
		if (last.text === text) return message;
		// 只补全前缀；已经更长 / 内容不同（比如两段正文被并到一个块里）就不碰
		if (!text.startsWith(last.text)) return message;
		blocks[blocks.length - 1] = { kind: "text", text };
		return { ...message, blocks };
	}
	if (last.kind === "tool") return message;
	return { ...message, blocks: [...blocks, { kind: "text", text }] };
}

export function startTool(
	message: UiMessage,
	input: { toolCallId: string; name: string; argsSummary: string; argsFull?: string; startedAt: number },
): UiMessage {
	const block: ToolBlock = {
		kind: "tool",
		toolCallId: input.toolCallId,
		name: input.name,
		argsSummary: input.argsSummary,
		// 摘要已经够短就不重复带一份：界面靠「有没有 argsFull」判断要不要显示「完整命令」
		...(input.argsFull && input.argsFull !== input.argsSummary ? { argsFull: input.argsFull } : {}),
		status: "running",
		outputExcerpt: "",
		truncated: false,
		startedAt: input.startedAt,
	};
	return { ...message, blocks: [...message.blocks, block] };
}

/** 摘录预算（ADR-0004 §5）：超限截断并打标记，而不是把 200KB 塞进快照 */
function truncateExcerpt(output: string, limit = TOOL_EXCERPT_CHARS): { outputExcerpt: string; truncated: boolean } {
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

/**
 * 追加一条错误提示。
 *
 * **同一条错误只留一个块**（2026-11-13 用户：「这种出来一条提示就行，不用这么多」）：
 * 一次连接抖动会被重试好几次（pi 自己重试 + 宿主补试），每一跳失败都发一次 `error` 事件，
 * 于是对话里摞出四、五条一模一样的红条 —— 人只想知道「连不上，已经试了几次」。
 * 所以这里改成：同 code + 同 message 就**就地合并**，次数累加进 `count`，不再往后 append。
 *
 * 就地（而不是「删掉前面的、补到最后」）是为了不抖动：块的位置一旦跳，
 * 下面那些正文和工具卡会跟着位移，看起来像在闪。
 */
export function appendError(message: UiMessage, code: string, text: string): UiMessage {
	const blocks = [...message.blocks];
	const existing = blocks.findIndex(
		(block) => block.kind === "error" && block.code === code && block.message === text,
	);
	const current = existing >= 0 ? blocks[existing] : undefined;
	if (current && current.kind === "error") {
		blocks[existing] = { ...current, count: (current.count ?? 1) + 1 };
		return { ...message, blocks };
	}
	blocks.push({ kind: "error", code, message: text, count: 1 });
	return { ...message, blocks };
}

/** 追加思考文本（与正文分开：正文说结论，思考说过程） */
export function appendThinking(message: UiMessage, text: string): UiMessage {
	const blocks = [...message.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.kind === "thinking") blocks[blocks.length - 1] = { kind: "thinking", text: last.text + text };
	else blocks.push({ kind: "thinking", text });
	return { ...message, blocks };
}
