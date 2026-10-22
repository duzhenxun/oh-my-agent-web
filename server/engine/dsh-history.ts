/**
 * DSH 会话日志 → 工作台的对话区消息 / 转录 / 统计（纯函数，单测直接覆盖）。
 *
 * 与 `dsh-log.ts` 分工：那边只管**怎么把文件读出来**（多帧 zstd、定位、标题素材），
 * 这里只管**怎么映射成我们的形状**（消息块 / 工具状态 / 四桶用量）。
 *
 * 两条纪律：
 *   1. `source.kind !== "user"` 的 user/message 是系统注入（runtime-context / skill-catalog / goal…），
 *      不进对话区、不参与计数；
 *   2. 工具块先立成 running，由 `tool/result` 收口；没有结果的（被中断）最后标 failed，
 *      不能一直转圈骗人。
 */
import { TOOL_EXCERPT_CHARS, type SessionStats, type UiMessage } from "../protocol.js";
import type { EngineMessage } from "./port.js";
import { isInternalUserMessage, type DshSessionLog } from "./dsh-log.js";

/** 取 content[] 里的文本（user 消息与工具结果共用） */
function textOf(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.map((block) => {
			const item = block as { type?: string; text?: string };
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

/** 一个 assistant/message 的 message 里可能出现的块 */
type AssistantBlock = { type?: string; text?: string; id?: string; name?: string; arguments?: string };

/** 日志 → 对话区消息（历史回放）。工具块先立成 running，由 tool/result 收口 */
export function logToUiMessages(log: DshSessionLog): UiMessage[] {
	const messages: UiMessage[] = [];
	const toolBlocks = new Map<string, { message: UiMessage; block: Extract<UiMessage["blocks"][number], { kind: "tool" }> }>();

	for (const event of log.events) {
		const ts = typeof event.time === "number" ? event.time : 0;
		if (event.type === "user/message") {
			if (isInternalUserMessage(event.data)) continue;
			const text = textOf(event.data?.content);
			if (text.trim() === "") continue;
			const id = typeof event.data?.id === "string" ? event.data.id : `u-${event.seq ?? messages.length}`;
			messages.push({ id: `u-${id}`, role: "user", ts, blocks: [{ kind: "text", text }] });
			continue;
		}
		if (event.type === "assistant/message") {
			const message = event.data?.message as
				| { id?: string; content?: AssistantBlock[]; model?: string }
				| undefined;
			if (!message) continue;
			const id = message.id ?? `a-${event.seq ?? messages.length}`;
			const blocks: UiMessage["blocks"] = [];
			for (const block of message.content ?? []) {
				if (block.type === "reasoning" && typeof block.text === "string" && block.text !== "") {
					blocks.push({ kind: "thinking", text: block.text });
					continue;
				}
				if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
					blocks.push({ kind: "text", text: block.text });
					continue;
				}
				if (block.type === "tool-call") {
					const toolCallId = block.id ?? `tool-${event.seq ?? 0}`;
					const args = block.arguments ?? "";
					const toolBlock = {
						kind: "tool" as const,
						toolCallId,
						name: block.name ?? "tool",
						argsSummary: args.length > 300 ? `${args.slice(0, 300)}…` : args,
						status: "running" as const,
						outputExcerpt: "",
						truncated: false,
						startedAt: ts,
					};
					blocks.push(toolBlock);
					continue;
				}
			}
			if (blocks.length === 0) continue;
			const ui: UiMessage = {
				id: `a-${id}`,
				role: "assistant",
				ts,
				endedAt: ts,
				blocks,
				...(typeof message.model === "string" ? { model: message.model } : {}),
			};
			messages.push(ui);
			for (const block of blocks) if (block.kind === "tool") toolBlocks.set(block.toolCallId, { message: ui, block });
			continue;
		}
		if (event.type === "tool/result") {
			const result = event.data?.message as
				| { toolCallId?: string; content?: unknown; isError?: boolean }
				| undefined;
			const toolCallId = result?.toolCallId;
			if (!toolCallId) continue;
			const found = toolBlocks.get(toolCallId);
			if (!found) continue;
			const raw = textOf(result?.content);
			const clipped = raw.length > TOOL_EXCERPT_CHARS ? `${raw.slice(0, TOOL_EXCERPT_CHARS)}…` : raw;
			found.block.status = result?.isError === true ? "failed" : "ok";
			found.block.outputExcerpt = clipped;
			found.block.truncated = raw.length > TOOL_EXCERPT_CHARS;
			found.block.endedAt = ts;
		}
	}

	// 没有结果的工具调用（被中断/崩溃）：不能留在 running 上骗人
	for (const { block } of toolBlocks.values()) {
		if (block.status === "running") block.status = "failed";
	}
	return messages;
}

/** 日志 → 引擎转录（只留正文，给需要纯文本的地方用） */
export function logToTranscript(log: DshSessionLog): EngineMessage[] {
	const out: EngineMessage[] = [];
	const source = log.events;
	for (const event of source) {
		if (event.type === "user/message") {
			if (isInternalUserMessage(event.data)) continue;
			const text = textOf(event.data?.content).trim();
			if (text !== "") out.push({ role: "user", text, ts: typeof event.time === "number" ? event.time : 0 });
			continue;
		}
		if (event.type === "assistant/message") {
			const message = event.data?.message as { content?: AssistantBlock[] } | undefined;
			const text = (message?.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
			if (text.trim() !== "") out.push({ role: "assistant", text, ts: typeof event.time === "number" ? event.time : 0 });
		}
	}
	return out;
}

type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** 日志 → 会话统计（用量来自 assistant/message.data.usage，四桶互斥） */
export function statsFromLog(log: DshSessionLog): SessionStats | null {
	const stats: SessionStats = {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		contextTokens: 0,
	};
	let seen = false;
	for (const event of log.events) {
		if (event.type === "user/message") {
			if (isInternalUserMessage(event.data)) continue;
			stats.userMessages += 1;
			seen = true;
			continue;
		}
		if (event.type === "assistant/message") {
			stats.assistantMessages += 1;
			seen = true;
			const content = (event.data?.message as { content?: AssistantBlock[] } | undefined)?.content ?? [];
			stats.toolCalls += content.filter((block) => block.type === "tool-call").length;
			const usage = event.data?.usage as Usage | undefined;
			if (usage) {
				const input = number(usage.inputTokens);
				const output = number(usage.outputTokens);
				const cacheRead = number(usage.cacheReadTokens);
				const cacheWrite = number(usage.cacheWriteTokens);
				stats.inputTokens += input;
				stats.outputTokens += output;
				stats.cacheRead += cacheRead;
				stats.cacheWrite += cacheWrite;
				stats.contextTokens = input + cacheRead + cacheWrite;
			}
			continue;
		}
		if (event.type === "tool/result") {
			stats.toolResults += 1;
			seen = true;
		}
	}
	if (!seen) return null;
	stats.totalMessages = stats.userMessages + stats.assistantMessages;
	stats.totalTokens = stats.inputTokens + stats.outputTokens + stats.cacheRead + stats.cacheWrite;
	return stats;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
