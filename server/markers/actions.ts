/**
 * 建议操作标记 `[[action:suggest:…]]`（ADR-0022）。
 *
 * 模型在回复正文里写标记 → 服务端解析 → 从「给人看的文本」里剥离 → 建议项进快照 →
 * 前端在对话底部渲染按钮（点击即发送）。全程纯文本，不需要模型调用任何工具。
 *
 * 语法（与参考实现 pi-web-ui 兼容）：
 *   [[action:suggest:继续]]                             → 按钮「继续」，点击发送「继续」
 *   [[action:suggest:继续第 2 步,prompt=按 A 方案继续]]  → 显示与发送内容分离
 *   [[action:clear:all]]                                → 清空
 *   别名：[[action:next:…]]、[[suggest:…]]
 */
import type { ActionItem, MessageBlock, TextBlock, UiMessage } from "../protocol.js";

/**
 * 「想一想」（换一批建议）用的隐藏指令哨兵。
 *
 * 它不是一个 action 标记（命名空间 `agent-web` 不在 KNOWN_TOOLS 里），
 * 作用只有一个：让历史回放能认出「这条用户消息是我们自己发的重生成请求」并把它丢掉，
 * 否则用户会在对话里看到一条莫名其妙的「请再给三条建议」。
 */
export const REFRESH_ACTIONS_SENTINEL = "[[agent-web:refresh-actions]]";

/**
 * 「想一想」要发给模型的指令（纯函数，单测覆盖）。
 *
 * 两个刻意的写法：
 *   - 示例给**空标记** `[[action:suggest:]]`（解析器会忽略空标签）—— 模型即使原样抄回来也不会冒假建议；
 *   - 明确「4 到 5 条」：ADR-0039 定的条数（3 条里常有一条是废话）。
 */
export function buildRefreshActionsPrompt(labels: string[], count?: number | null): string {
	const avoid = labels.length > 0 ? `（不要和这些重复：${labels.join("、")}）` : "";
	// 手机上一行放不下 4~5 个按钮：客户端可以指定「就要 3 条」。
	const wanted = typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 5 ? count : null;
	const amount = wanted === null ? "4 到 5 条" : `${wanted} 条`;
	// **一行**：这条指令在引擎侧会作为一条真实用户消息落盘（DSH web / pi CLI 里也看得见），
	// 所以压到最短，同时语法自包含（dsh / codex 没有系统提示教它这个格式）。
	return `${REFRESH_ACTIONS_SENTINEL} 再给 ${amount}不同的下一步建议${avoid}，每行一条 [[action:suggest:]]（把按钮文字填在 suggest: 后面），只输出标记，不要正文。`;
}

/** 这条用户消息是不是「想一想」的隐藏请求 */
export function isRefreshActionsPrompt(text: string): boolean {
	return text.trimStart().startsWith(REFRESH_ACTIONS_SENTINEL);
}

export const MAX_ACTIONS = 5; // 每轮建议 4~5 条：超过只留最新的那批
export const MAX_LABEL_CHARS = 80;
export const MAX_PROMPT_CHARS = 2000;

/** 已认识的标记命名空间（只剥离这些，避免误删正文里的普通双括号） */
const KNOWN_TOOLS = ["action", "suggest"];

/** 匹配 `[[tool:op:body]]`（body 里不允许再出现 `[[`，避免嵌套误伤） */
// op 段可选：[[suggest:下一步]] 与 [[action:suggest:下一步]] 都要认
const TOKEN_RE = /\[\[\s*([a-z]+)\s*:\s*(?:([a-z]+)\s*:\s*)?([^[\]]*?)\s*\]\]/gi;

/** 流式期间：末尾那个还没闭合的半截标记（例如 `[[action:su`）也不该显示出来 */
const TRAILING_INCOMPLETE_RE = /[ \t]*\[\[\s*(?:action|suggest)(?:\s*:[^\]]*)?$/i;

export type ParsedActionToken = { kind: "suggest"; label: string; prompt: string } | { kind: "clear" };

function splitBody(body: string): { args: string[]; kwargs: Record<string, string> } {
	const args: string[] = [];
	const kwargs: Record<string, string> = {};
	let rest = body;
	// 先把 kwargs 抽出来（`prompt=xxx` 可能含逗号 → 按 `,key=` 切）
	const segments = rest.split(",");
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (trimmed === "") continue;
		const index = trimmed.indexOf("=");
		const key = index > 0 ? trimmed.slice(0, index).trim() : "";
		if (key !== "" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) kwargs[key.toLowerCase()] = trimmed.slice(index + 1).trim();
		else args.push(trimmed);
	}
	rest = "";
	void rest;
	return { args, kwargs };
}

/** 纯函数：解析文本里的建议操作标记（畸形标记直接忽略，不当成错误） */
export function parseActionMarkers(text: string): ParsedActionToken[] {
	if (!text.includes("[[")) return [];
	const tokens: ParsedActionToken[] = [];
	TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TOKEN_RE.exec(text)) !== null) {
		const [, tool, op, body] = match;
		const toolName = tool.toLowerCase();
		// 没写 op 的（[[suggest:文字]] / [[action:文字]]）按 suggest 处理
		const opName = (op ?? "suggest").toLowerCase();
		if (!KNOWN_TOOLS.includes(toolName)) continue;
		if (body.includes("[[")) continue; // 嵌套/畸形：不认

		if (opName === "clear") {
			if (body.trim() === "all" || body.trim() === "") tokens.push({ kind: "clear" });
			continue;
		}
		if (!["suggest", "add", "next", "reply", "choice", "option"].includes(opName)) continue;

		const { args, kwargs } = splitBody(body);
		const argText = args.join(",").trim();
		const label = (kwargs.label ?? argText).trim();
		const prompt = (kwargs.prompt ?? argText).trim();
		if (label === "" && prompt === "") continue;
		tokens.push({
			kind: "suggest",
			label: (label || prompt).slice(0, MAX_LABEL_CHARS),
			prompt: (prompt || label).slice(0, MAX_PROMPT_CHARS),
		});
	}
	return tokens;
}

/**
 * 纯函数：从展示文本里剥离标记。
 * `stripTrailingIncomplete` 用于流式期间（把还没闭合的半截标记也去掉）。
 */
export function stripMarkers(text: string, options: { stripTrailingIncomplete?: boolean } = {}): string {
	if (!text.includes("[[")) return text;
	let out = text.replace(TOKEN_RE, (raw, tool: string, _op: string, body: string) => {
		if (!KNOWN_TOOLS.includes(String(tool).toLowerCase())) return raw;
		if (body.includes("[[")) return raw;
		return "";
	});
	if (options.stripTrailingIncomplete) out = out.replace(TRAILING_INCOMPLETE_RE, "");
	if (out === text) return text;
	// 剥离后可能留下空行（标记通常独占一行）
	return out
		.replace(/^[ \t]+\n/gm, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

/** 纯函数：把一段助手文本归约成「干净文本 + 建议列表」 */
export function reduceActionMarkers(
	text: string,
	current: ActionItem[],
	nextId: () => string,
): { text: string; actions: ActionItem[] } {
	const tokens = parseActionMarkers(text);
	if (tokens.length === 0) return { text, actions: current };

	let actions = [...current];
	for (const token of tokens) {
		if (token.kind === "clear") {
			actions = [];
			continue;
		}
		const exists = actions.some((item) => item.label === token.label && item.prompt === token.prompt);
		if (exists) continue;
		actions.push({ id: nextId(), label: token.label, prompt: token.prompt });
		if (actions.length > MAX_ACTIONS) actions = actions.slice(actions.length - MAX_ACTIONS);
	}

	return { text: stripMarkers(text), actions };
}

/**
 * 流式过滤器：把「可能是标记开头」的内容先扣住。
 *
 * 为什么需要它：模型是逐字吐出来的，`[[action:suggest:继续]]` 会被拆成好几个 chunk。
 * 如果只在回合结束时剥离，用户会在流式过程中看到原始语法（截图里就这么被撞见过）。
 * 而「边流边剥」不能靠事后删除（客户端只支持追加重建），只能**先把可能是标记的尾巴扣住**：
 *   - 遇到 `[[` 就暂停输出，等它闭合；
 *   - 闭合后：是认识的标记 → 直接丢弃；不是认识的（如 `[[todo:...]]`）→ 当普通文本补上；
 *   - 长时间不闭合（横文里的双括号）→ 超过上限就当下普通文本吐出，不能把内容卡死。
 */
export const MAX_PENDING_CHARS = 500;

export type MarkerStreamFilter = {
	/** 吐出一个 chunk，返回「现在可以安全显示的部分」（可能为空） */
	push: (chunk: string) => string;
	/** 回合结束：把还扣着的尾巴交出来（已经不可能是标记了） */
	flush: () => string;
};

export function createMarkerStreamFilter(): MarkerStreamFilter {
	let pending = "";

	const drain = (final: boolean): string => {
		let out = "";
		for (;;) {
			const start = pending.indexOf("[[");
			if (start < 0) {
				// 没有完整的 "[["：但结尾可能孤立着一个 "["（下一个 chunk 才补上第二个）→ 扣住它
				if (!final && pending.endsWith("[")) {
					out += pending.slice(0, -1);
					pending = "[";
					return out;
				}
				out += pending;
				pending = "";
				return out;
			}
			out += pending.slice(0, start);
			const rest = pending.slice(start);
			const end = rest.indexOf("]]");

			if (end < 0) {
				// 还没闭合：扣住等内容（除非已经不可能是个标记）
				if (final || rest.length > MAX_PENDING_CHARS) {
					out += rest;
					pending = "";
					return out;
				}
				pending = rest;
				return out;
			}

			const expression = rest.slice(0, end + 2);
			pending = rest.slice(end + 2);
			// 认识的名字空间：丢弃；不认识的：当普通文本吐出（与 stripMarkers 一个口径）
			const known = /^\[\[\s*(?:action|suggest)\s*:/i.test(expression);
			if (!known) out += expression;
		}
	};

	return {
		push(chunk) {
			if (chunk === "") return "";
			pending += chunk;
			return drain(false);
		},
		flush() {
			return drain(true);
		},
	};
}

/**
 * 把标记从一条消息里落实：剥离正文里的标记，并把建议项追加到当前列表。
 * 只改文本块（工具卡与错误块不动）。
 */
export function applyMarkersToMessage(
	message: { blocks: MessageBlock[] },
	current: ActionItem[],
	nextId: () => string,
): { blocks: MessageBlock[]; actions: ActionItem[] } {
	const rawText = message.blocks
		.filter((block): block is TextBlock => block.kind === "text")
		.map((block) => block.text)
		.join("");
	if (!rawText.includes("[[")) return { blocks: message.blocks, actions: current };

	const { text: cleaned, actions } = reduceActionMarkers(rawText, current, nextId);
	// 把全部文本块合并成一块干净文本，并接在第一个文本块的位置上（保序）
	const firstTextIndex = message.blocks.findIndex((block) => block.kind === "text");
	const nonTextBefore = message.blocks.slice(0, firstTextIndex).filter((block) => block.kind !== "text");
	const nonTextAfter = message.blocks.slice(firstTextIndex).filter((block) => block.kind !== "text");
	const blocks: MessageBlock[] = [
		...nonTextBefore,
		...(cleaned.trim() === "" ? [] : [{ kind: "text", text: cleaned } satisfies TextBlock]),
		...nonTextAfter,
	];
	return { blocks, actions };
}

/**
 * 历史回放清洗（pi / dsh 共用）：
 *   1. 丢掉「想一想」的隐藏请求（用户不该看到那条内部消息）；
 *   2. 剥掉正文里残留的 action 标记（历史记录里存的是原文）；
 *   3. 剥完变空的消息（例如模型只回了三条标记）直接丢掉，不留空气泡。
 */
export function sanitizeHistoricalActions(messages: UiMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = message.blocks
				.filter((block): block is TextBlock => block.kind === "text")
				.map((block) => block.text)
				.join("");
			if (isRefreshActionsPrompt(text)) continue;
			// 防御：哨兵被引擎包了一层（或模型回显到助手消息里）时也要剥掉
			const blocks = message.blocks.map((block) =>
				block.kind === "text" && block.text.includes(REFRESH_ACTIONS_SENTINEL)
					? { ...block, text: block.text.split(REFRESH_ACTIONS_SENTINEL).join("").trim() }
					: block,
			);
			const cleaned = blocks.filter((block) => block.kind !== "text" || block.text.trim() !== "");
			if (cleaned.length === 0) continue;
			out.push({ ...message, blocks: cleaned });
			continue;
		}
		if (!message.blocks.some((block) => block.kind === "text")) {
			out.push(message);
			continue;
		}
		const cleaned = message.blocks.map((block) =>
			block.kind === "text" ? { ...block, text: stripMarkers(block.text) } : block,
		);
		const blocks = cleaned.filter((block) => block.kind !== "text" || block.text.trim() !== "");
		if (blocks.length === 0) continue;
		out.push({ ...message, blocks });
	}
	return out;
}
