/**
 * 把 pi 会话的条目映射成界面消息（ADR-0021 §2：事实源换成 pi 的会话存储之后，
 * 「显示」这件事就落在这个纯函数上）。
 *
 * 输入是 SDK 的 `SessionEntry[]`（我们只认识其中两种：
 *   `{type:"message", id, timestamp, message}` 与其它状态条目——后者忽略）。
 * 输出是我们的 `UiMessage[]`（text / tool / error 三类块）。
 *
 * 刻意**不 import SDK 类型**：只用最小结构描述（TS 里用 unknown + 收窄），
 * 这样单测可以用合成条目直接覆盖，不需要拉起 SDK。
 */
import { TOOL_EXCERPT_CHARS, type MessageBlock, type UiMessage } from "../protocol.js";
import { sanitizeHistoricalActions } from "../markers/actions.js";
import { parseUsage } from "../util/usage.js";
import { scheduledCost } from "../util/pricing-index.js";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
	return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return typeof record.text === "string" ? record.text : "";
		})
		.join("");
}

/** 工具结果里的退出码（不同工具的 details 形状不同，取不到就不给） */
function exitCodeOf(details: unknown): number | undefined {
	const record = asRecord(details);
	const value = record.exitCode ?? asRecord(record.structuredContent).exitCode;
	return typeof value === "number" ? value : undefined;
}

function truncate(text: string): { outputExcerpt: string; truncated: boolean } {
	if (text.length <= TOOL_EXCERPT_CHARS) return { outputExcerpt: text, truncated: false };
	return { outputExcerpt: text.slice(0, TOOL_EXCERPT_CHARS), truncated: true };
}

/**
 * 把一条 SDK message 转成「消息 + 其中的工具块」。
 *
 * 助手消息只是**一次模型调用**：一轮里有几次工具轮次就有几条。调用方会把同一轮里的
 * 助手消息**合并成一条界面消息**（见 entriesToUiMessagesRaw）—— 界面上一次提问只该有一个
 * 回复气泡，费用与 token 也要按整轮累加。
 */
function mapMessage(entryId: string, message: unknown, order: number): UiMessage | null {
	const record = asRecord(message);
	const role = record.role;
	const ts = typeof record.timestamp === "number" ? record.timestamp : Date.now();

	if (role === "user") {
		const text = textOfContent(record.content);
		if (text.trim() === "") return null;
		return { id: entryId, role: "user", ts, blocks: [{ kind: "text", text }] };
	}

	if (role === "assistant") {
		const usage = parseUsage(record.usage);
		// 这条消息自己用的模型（历史按当时的模型显示，不跟当前选择变）
		const provider = typeof record.provider === "string" ? record.provider : "";
		const modelId = typeof record.model === "string" ? record.model : "";
		const model = modelId ? (provider ? `${provider}/${modelId}` : modelId) : undefined;
		const blocks: MessageBlock[] = [];
		const content = Array.isArray(record.content) ? record.content : [];
		for (const part of content) {
			const item = asRecord(part);
			if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") {
				blocks.push({ kind: "text", text: item.text });
				continue;
			}
			// 思考过程也回放出来（「过程」里要按发生顺序摆，历史里没有它就对不上）
			if (
				item.type === "thinking" &&
				typeof (item.thinking ?? item.text ?? item.reasoning) === "string" &&
				String(item.thinking ?? item.text ?? item.reasoning).trim() !== ""
			) {
				blocks.push({ kind: "thinking", text: String(item.thinking ?? item.text ?? item.reasoning) });
				continue;
			}
			if (item.type === "toolCall" || item.type === "tool_use") {
				blocks.push({
					kind: "tool",
					toolCallId: String(item.id ?? `tool-${order}-${blocks.length}`),
					name: String(item.name ?? "unknown"),
					argsSummary: summarize(item.arguments),
					// 结果在后面的条目里回填；此刻只表明「调用过」
					status: "ok",
					outputExcerpt: "",
					truncated: false,
					startedAt: ts,
				});
			}
			// 其它部件（images 等）不进界面
		}
		if (blocks.length === 0) return null;
		// 分时价格（ADR-0026 D 期）：配了时段表就按这条消息的时间算钱，
		// 不沿用会话里 pi 当时按全天价算出来的 cost（否则历史一会儿是旧价、一会儿是新价）
		const priced = usage && model ? scheduledCost(model, usage, ts) : undefined;
		const finalUsage = usage && priced !== undefined ? { ...usage, cost: priced } : usage;
		return {
			id: entryId,
			role: "assistant",
			ts,
			blocks,
			...(finalUsage ? { usage: finalUsage } : {}),
			...(model ? { model } : {}),
		};
	}

	return null; // system / toolResult 单独处理
}

/** 两段用量相加（一轮里多次模型调用 → 合计；cost 拿不到就不给，别编 0） */
function addUsage(base: UiMessage["usage"], extra: NonNullable<UiMessage["usage"]>): NonNullable<UiMessage["usage"]> {
	const cost = (base?.cost ?? 0) + (extra.cost ?? 0);
	return {
		input: (base?.input ?? 0) + extra.input,
		output: (base?.output ?? 0) + extra.output,
		cacheRead: (base?.cacheRead ?? 0) + extra.cacheRead,
		cacheWrite: (base?.cacheWrite ?? 0) + extra.cacheWrite,
		...(base?.cost === undefined && extra.cost === undefined ? {} : { cost }),
	};
}

function summarize(args: unknown): string {
	if (typeof args === "string") return args;
	try {
		const text = JSON.stringify(args ?? {});
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return "(无法序列化的参数)";
	}
}

/**
 * 纯函数：条目 → 界面消息。
 * 工具结果按 `toolCallId` 回填到最近的对应工具块（找不到就补一条工具块，保证结果不丢）。
 */
export function entriesToUiMessages(entries: unknown[]): UiMessage[] {
	return sanitizeHistoricalActions(entriesToUiMessagesRaw(entries));
}

function entriesToUiMessagesRaw(entries: unknown[]): UiMessage[] {
	const messages: UiMessage[] = [];
	/** toolCallId → 已经放进消息里的那个块（用于回填结果） */
	const toolBlocks = new Map<string, Extract<MessageBlock, { kind: "tool" }>>();

	for (const [order, entry] of entries.entries()) {
		const record = asRecord(entry);
		if (record.type !== "message") continue; // 状态类条目（model_change / thinking_level_change …）不进界面
		const entryId = typeof record.id === "string" ? record.id : `entry-${order}`;
		const message = asRecord(record.message);

		if (message.role === "toolResult") {
			const toolCallId = String(message.toolCallId ?? "");
			const block = toolBlocks.get(toolCallId);
			const { outputExcerpt, truncated } = truncate(textOfContent(message.content));
			const failed = message.isError === true;
			if (block) {
				const exitCode = exitCodeOf(message.details);
				block.status = failed ? "failed" : "ok";
				block.outputExcerpt = outputExcerpt;
				block.truncated = truncated;
				block.endedAt = typeof message.timestamp === "number" ? message.timestamp : block.startedAt;
				if (exitCode !== undefined) block.exitCode = exitCode;
			} else {
				// 找不到对应调用（老会话里可能有）：补一条工具块，保证结果不丢
				const exitCode = exitCodeOf(message.details);
				const ts2 = typeof message.timestamp === "number" ? message.timestamp : Date.now();
				messages.push({
					id: entryId,
					role: "assistant",
					ts: ts2,
					blocks: [
						{
							kind: "tool",
							toolCallId,
							name: String(message.toolName ?? "unknown"),
							argsSummary: "",
							status: failed ? "failed" : "ok",
							outputExcerpt,
							truncated,
							startedAt: ts2,
							endedAt: ts2,
							...(exitCode === undefined ? {} : { exitCode }),
						},
					],
				});
			}
			continue;
		}

		const mapped = mapMessage(entryId, message, order);
		if (!mapped) continue;
		// 同一轮里的助手消息合并成一条（工具轮次会有很多条）：界面上一次提问只有一个回复气泡，
		// token / 费用也跟着累加 —— 否则历史里看到的是「每次模型调用各一条」，总数还得自己加。
		const previous = messages.at(-1);
		if (previous && previous.role === "assistant") {
			previous.blocks = [...previous.blocks, ...mapped.blocks];
			if (mapped.usage) previous.usage = addUsage(previous.usage, mapped.usage);
			if (mapped.model) previous.model = mapped.model;
			// 完成时间 = 这一轮最后一次模型调用的时间
			previous.endedAt = mapped.ts;
			for (const block of mapped.blocks) {
				if (block.kind === "tool") toolBlocks.set(block.toolCallId, block);
			}
			continue;
		}
		messages.push(mapped);
		for (const block of mapped.blocks) {
			if (block.kind === "tool") toolBlocks.set(block.toolCallId, block);
		}
	}

	return messages;
}

/** 从条目里取「首条用户消息」当标题（侧栏用；扫描器也有一份同口径实现） */
export function firstUserText(entries: unknown[]): string {
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record.type !== "message") continue;
		const message = asRecord(record.message);
		if (message.role !== "user") continue;
		const text = textOfContent(message.content).replace(/\s+/g, " ").trim();
		if (text !== "") return text;
	}
	return "";
}
