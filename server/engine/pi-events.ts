/**
 * SDK 会话事件 → 端口事件的映射（ADR-0003 的端口实现里最容易出错的一层）。
 *
 * 从 `pi-sdk.ts` 拆出（400 行护栏）：这是**纯映射**，与「怎么建会话、怎么订阅」无关，
 * 所以可以脱离 SDK 用合成事件直接测（单测覆盖整张映射表，不烧 token）。
 */
import type { EngineEvent } from "./port.js";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
	return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

/** 把工具结果里的文本抽出来（content 是 {type:"text",text} 数组） */
export function resultText(result: unknown): string {
	const content = asRecord(result).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** 把 bash 工具结果的退出码抠出来（不同工具 details 形状不同，取不到就不给） */
export function resultExitCode(result: unknown): number | undefined {
	const details = asRecord(asRecord(result).details);
	const value = details.exitCode ?? asRecord(asRecord(result).structuredContent).exitCode;
	return typeof value === "number" ? value : undefined;
}

/** 参数摘要（给界面与审批用） */
export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return args;
	try {
		const text = JSON.stringify(args ?? {});
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return "(无法序列化的参数)";
	}
}

/**
 * 纯函数：把 SDK 会话事件翻译成端口事件。返回 null 表示这个事件不影响 UI。
 * （单测用合成事件直接覆盖这张映射表 —— 不需要真的连模型。）
 */
export function mapSessionEvent(event: unknown): EngineEvent | null {
	const record = asRecord(event);
	const type = record.type;

	if (type === "message_update") {
		const assistantEvent = asRecord(record.assistantMessageEvent);
		if (
			assistantEvent.type === "text_delta" &&
			typeof assistantEvent.delta === "string" &&
			assistantEvent.delta !== ""
		) {
			return { type: "text_delta", text: assistantEvent.delta };
		}
		// 模型的思考过程：单独一类事件，界面上折叠展示（不是正文）
		if (
			assistantEvent.type === "thinking_delta" &&
			typeof assistantEvent.delta === "string" &&
			assistantEvent.delta !== ""
		) {
			return { type: "thinking_delta", text: assistantEvent.delta };
		}
		return null; // tool_use 等：v1 不展示
	}

	if (type === "tool_execution_start") {
		const toolCallId = String(record.toolCallId ?? "");
		const name = String(record.toolName ?? "");
		return { type: "tool_start", toolCallId, name, argsSummary: summarizeArgs(record.args) };
	}

	if (type === "tool_execution_end") {
		const toolCallId = String(record.toolCallId ?? "");
		const exitCode = resultExitCode(record.result);
		return {
			type: "tool_end",
			toolCallId,
			status: record.isError === true ? "failed" : "ok",
			output: resultText(record.result),
			...(exitCode === undefined ? {} : { exitCode }),
		};
	}

	return null;
}
