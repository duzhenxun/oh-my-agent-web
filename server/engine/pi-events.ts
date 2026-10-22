/**
 * SDK 会话事件 → 端口事件的映射（ADR-0003 的端口实现里最容易出错的一层）。
 *
 * 从 `pi-sdk.ts` 拆出（400 行护栏）：这是**纯映射**，与「怎么建会话、怎么订阅」无关，
 * 所以可以脱离 SDK 用合成事件直接测（单测覆盖整张映射表，不烧 token）。
 */
import { parseUsage } from "../util/usage.js";
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

/** 同一类失败的统一出口：能把原因带给用户就带，拿不到给一句可读的兜底 */
function providerError(raw: unknown): EngineEvent {
	const text =
		typeof raw === "string" && raw.trim() !== ""
			? raw.trim()
			: typeof asRecord(raw).message === "string" && asRecord(raw).message !== ""
				? String(asRecord(raw).message)
				: "模型调用失败（provider 没有给出原因）";
	return { type: "error", code: "engine.provider_error", message: text };
}

/**
 * 纯函数：把 SDK 会话事件翻译成端口事件。返回 null 表示这个事件不影响 UI。
 * （单测用合成事件直接覆盖这张映射表 —— 不需要真的连模型。）
 */
export function mapSessionEvent(event: unknown): EngineEvent | null {
	const record = asRecord(event);
	const type = record.type;

	if (type === "message_update") {
		const message = asRecord(record.message);
		const assistantEvent = asRecord(record.assistantMessageEvent);
		// ⚠️ 正文 / 思考的增量**必须优先**：SDK 的 message_update 里一旦带上 usage，
		// 之前那种「先看 usage 就 return」会把后面的每一个正文增量全吞掉 ——
		// 表现就是「只调工具、不回复」。所以先在前面处理 delta，usage 只在非 delta 更新上取。
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
		// 思考 / 正文之外的另一种增量：provider 直接报错（有的 provider 走这条，不走 message_end）
		if (assistantEvent.type === "error") return providerError(assistantEvent.error ?? assistantEvent.message);
		// 用量：SDK 的 message 上带 usage（各 provider 字段名不一样，统一解析）。
		// 这是**过程值**（final:false）：宿主只拿 message_end 那份求和，不能两边都算。
		const usage = parseUsage(message.usage);
		if (usage) return { type: "usage", ...usage, final: false };
		// 模型：**放最后**。有的 provider 每一帧 message 上都带 provider/model，
		// 一旦先返回它，后面的正文增量就全被吞了 —— 表现就是「助手不回复，只有用量」。
		if (typeof message.model === "string" && message.model !== "") {
			const provider = typeof message.provider === "string" ? message.provider : "";
			return { type: "model", model: provider ? `${provider}/${message.model}` : message.model };
		}
		return null; // tool_use 等：v1 不展示
	}

	// 一条消息开始：这一帧上带着 provider/model（拿它当「当前模型」的来源之一）
	if (type === "message_start") {
		const message = asRecord(record.message);
		if (typeof message.model === "string" && message.model !== "") {
			const provider = typeof message.provider === "string" ? message.provider : "";
			return { type: "model", model: provider ? `${provider}/${message.model}` : message.model };
		}
		return null;
	}

	// 一条消息结束：**最终**用量在这里（output 才统计全），同一条 message_update 上的是过程值
	if (type === "message_end") {
		const message = asRecord(record.message);
		// provider / 鉴权 / 网络的失败**不会抛异常**：SDK 会合成一条 stopReason=error 的消息
		// （带 errorMessage）然后正常 resolve。不在这里翻译成 error 事件，界面就是
		// 「空回复 + 没有任何报错 + 回合算完成」—— 用户根本不知道出了什么事。
		if (message.stopReason === "error") return providerError(message.errorMessage);
		// 一次模型调用的**最终**用量：宿主把一轮里的这些加起来 = 本轮总量（含工具轮次）
		const usage = parseUsage(message.usage);
		return usage ? { type: "usage", ...usage, final: true } : null;
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
