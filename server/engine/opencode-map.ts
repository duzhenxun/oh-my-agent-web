/**
 * opencode ACP 的**纯映射**（不碰网络/子进程）。
 *
 * 三件事：
 *   1. `configOptions`（模型 / 思考档）→ 我们的模型下拉与档位；
 *   2. `session/update` 通知 → 我们的 EngineEvent；
 *   3. `session/request_permission` → 我们的审批请求 + 回包选项。
 *
 * 实测依据（opencode 1.19.0，`opencode acp`）：
 *   - `session/new` 的 `configOptions` 有 2~3 项：
 *       `{id:"model", category:"model"}`、
 *       `{id:"effort", category:"thought_level"}`（**只有部分模型有**）、
 *       `{id:"mode", category:"mode"}`（build / plan）。
 *     所以「思考档」必须按 `category` 找，不能写死 id（dsh 那边叫 `reasoning_effort`）；
 *     换成不支持推理的模型（如 deepseek-office/deepseek-flash）时该项会**整个消失**。
 *   - 模型 value 是 `provider/model`，而 provider 自己也可能带斜杠
 *     （`cloudflare-ai-gateway/anthropic/claude-opus-4.5`）→ 解析只切**第一个**斜杠。
 *   - 工具是两段式：先来一条 `tool_call`（`title` 就是工具名 `bash`、`rawInput` 只有 `{cwd}`），
 *     真正的命令在随后 `tool_call_update` 的 `title`/`rawInput` 里；`status` 走
 *     pending → in_progress（可能多次）→ completed/failed。**所以 tool_start 要延迟到「有真参数」那一条**，
 *     否则界面上卡片会先写着 `bash {"cwd":"…"}`，很误导。
 *   - `completed` 的 update 带 `content[]` 与 `rawOutput{output, metadata{exit, truncated}}`（有时只有 status）。
 *   - `session/prompt` 返回 `{stopReason, usage:{inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens}}`
 *     —— 有 input/output 分桶（比 dsh 只给 used/size 强）；`usage_update` 通知则**不稳定**
 *     （同一个 opencode 版本，deepseek-office 的模型一次都没发），不能拿它算账。
 *   - 权限请求带完整 `toolCall`（含 `rawInput`）+ 三个选项：
 *     `{optionId:"once", kind:"allow_once"}` / `{optionId:"always", kind:"allow_always"}` / `{optionId:"reject", kind:"reject_once"}`。
 */
import { TOOL_EXCERPT_CHARS, type SessionStats, type UiMessage } from "../protocol.js";
import type { ApprovalRequest, EngineEvent, EngineMessage, EngineModelInfo } from "./port.js";

type OpencodeChoice = { value: string; name?: string; description?: string; group?: string };

export type OpencodeConfigOption = {
	id: string;
	name?: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: Array<OpencodeChoice | { group: string; name?: string; options: OpencodeChoice[] }>;
};

type OpencodePermissionOption = { optionId: string; name?: string; kind?: string };

export type OpencodePermissionRequest = {
	sessionId?: string;
	toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
	options?: OpencodePermissionOption[];
};

/** 把 configOptions 里可能分组的选项摊平（保留 group 名，便于显示） */
export function flattenChoices(option: OpencodeConfigOption | undefined): OpencodeChoice[] {
	if (!option?.options) return [];
	const out: OpencodeChoice[] = [];
	for (const entry of option.options) {
		if ("options" in entry && Array.isArray(entry.options)) {
			for (const choice of entry.options) out.push({ ...choice, group: choice.group ?? entry.group ?? entry.name });
		} else {
			out.push(entry as OpencodeChoice);
		}
	}
	return out;
}

/** `provider/model` → { provider, model }；provider 本身可能带斜杠，所以只切第一刀 */
export function parseModelValue(value: string | undefined | null): { provider: string; model: string } | null {
	if (!value) return null;
	const index = value.indexOf("/");
	if (index <= 0 || index === value.length - 1) return null;
	return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

const modelOptionOf = (config: OpencodeConfigOption[] | undefined): OpencodeConfigOption | undefined =>
	(config ?? []).find((entry) => entry.category === "model" || entry.id === "model");

export function modelOptions(config: OpencodeConfigOption[] | undefined): EngineModelInfo[] {
	const option = modelOptionOf(config);
	const current = option?.currentValue;
	const seen = new Set<string>();
	const models: EngineModelInfo[] = [];
	for (const choice of flattenChoices(option)) {
		const id = choice.value;
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			label: choice.name ?? id,
			...(id === current ? { current: true } : {}),
		});
	}
	return models;
}

export function currentModelId(config: OpencodeConfigOption[] | undefined): string | null {
	return modelOptionOf(config)?.currentValue ?? null;
}

/** 模型 id（就是 value 原文）→ ACP 需要的 value；不在列表里返回 null */
export function modelValueFor(config: OpencodeConfigOption[] | undefined, modelId: string): string | null {
	const option = modelOptionOf(config);
	if (!option) return null;
	for (const choice of flattenChoices(option)) {
		// label 也可能被当成 id 传进来（界面上显示的是 label），两种都认
		if (choice.value === modelId || choice.name === modelId) return choice.value;
	}
	return null;
}

/**
 * 思考档那一项：按 `category: "thought_level"` 找（dsh 叫 reasoning_effort，opencode 叫 effort）。
 * 不支持推理的模型没有这一项 → 返回 undefined，界面自动隐藏控件。
 */
function thinkingOptionOf(config: OpencodeConfigOption[] | undefined): OpencodeConfigOption | undefined {
	return (config ?? []).find(
		(entry) => entry.category === "thought_level" || entry.id === "effort" || entry.id === "reasoning_effort",
	);
}

export function thinkingLevels(config: OpencodeConfigOption[] | undefined): string[] {
	return flattenChoices(thinkingOptionOf(config))
		.map((choice) => choice.value)
		.filter((value): value is string => typeof value === "string" && value !== "");
}

export function currentThinkingLevel(config: OpencodeConfigOption[] | undefined): string | null {
	return thinkingOptionOf(config)?.currentValue ?? null;
}

/** 思考档位的 configId（切档位时用，随模型而变） */
export function thinkingConfigId(config: OpencodeConfigOption[] | undefined): string {
	return thinkingOptionOf(config)?.id ?? "effort";
}

// ---------------------------------------------------------------------------
// session/update 通知
// ---------------------------------------------------------------------------

export type OpencodeUpdate = {
	sessionUpdate?: string;
	messageId?: string;
	/** 文本块是 `{type:"text",text}`；工具结果是 `[{type:"content", content:{type:"text",text}}]` */
	content?: unknown;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
	rawOutput?: { output?: unknown; metadata?: { exit?: unknown; truncated?: unknown } | null } | null;
	configOptions?: unknown;
};

/** 取 content 里的纯文本（两种形状都认：单块对象 / 内容数组） */
export function textOfContent(content: unknown): string {
	if (content === undefined || content === null) return "";
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				const entry = item as { type?: string; content?: { type?: string; text?: string }; text?: string };
				if (entry?.content?.type === "text") return entry.content.text ?? "";
				if (entry?.type === "text") return entry.text ?? "";
				return "";
			})
			.join("");
	}
	const single = content as { type?: string; text?: string };
	return single?.type === "text" ? (single.text ?? "") : "";
}

/** 正文 / 思考增量 → 事件；其余类型返回 null（工具与配置由引擎自己处理） */
export function textEventOf(update: OpencodeUpdate): EngineEvent | null {
	if (update.sessionUpdate === "agent_message_chunk") {
		const text = textOfContent(update.content);
		return text === "" ? null : { type: "text_delta", text };
	}
	if (update.sessionUpdate === "agent_thought_chunk") {
		const text = textOfContent(update.content);
		return text === "" ? null : { type: "thinking_delta", text };
	}
	return null;
}

/** 工具事实：名字 + 参数（第一段 update 只有 `{cwd}`，后来才补上命令） */
export type ToolFacts = { toolCallId: string; title?: string; kind?: string; rawInput?: unknown };

/** opencode 的内置工具名：`title` 等于这些值时说明**还没**带上真参数，别急着开卡片 */
const GENERIC_TITLES = new Set([
	"bash",
	"edit",
	"write",
	"read",
	"multi-edit",
	"multiedit",
	"patch",
	"grep",
	"glob",
	"list",
	"ls",
	"webfetch",
	"task",
	"todowrite",
	"todoread",
	"skill",
]);

/**
 * 这条 update 是否已经「够格」开一张工具卡片。
 *
 * 判据：参数里有 `cwd` 之外的东西（bash 的真实命令 / edit 的路径），
 * 或者 title 已经不是工具名本身（opencode 把 bash 的 title 设成命令原文）。
 */
export function hasUsableToolFacts(facts: ToolFacts): boolean {
	const input = facts.rawInput;
	if (input !== null && typeof input === "object") {
		if (Object.keys(input as Record<string, unknown>).some((key) => key !== "cwd")) return true;
	}
	const title = (facts.title ?? "").trim();
	if (title === "") return false;
	return !GENERIC_TITLES.has(title.toLowerCase());
}

export function toolStartEvent(facts: ToolFacts): EngineEvent {
	const raw = facts.rawInput === undefined ? "" : safeJson(facts.rawInput);
	return {
		type: "tool_start",
		toolCallId: facts.toolCallId,
		name: (facts.title ?? "").trim() || facts.kind || "tool",
		argsSummary: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw,
		argsFull: raw,
	};
}

/** 工具收口：只有 completed / failed 才发（in_progress 是过程态） */
export function isFinalToolStatus(status: string | undefined): boolean {
	return status === "completed" || status === "failed" || status === "error" || status === "cancelled";
}

export function toolEndEvent(update: OpencodeUpdate): EngineEvent {
	const raw = update.rawOutput?.output;
	const output = typeof raw === "string" ? raw : textOfContent(update.content);
	const exit = update.rawOutput?.metadata?.exit;
	return {
		type: "tool_end",
		toolCallId: update.toolCallId ?? "opencode-tool",
		status: update.status === "completed" ? "ok" : "failed",
		output,
		...(typeof exit === "number" ? { exitCode: exit } : {}),
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// session/prompt 的结果
// ---------------------------------------------------------------------------

export type OpencodePromptResult = {
	stopReason?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cachedReadTokens?: number;
		thoughtTokens?: number;
		totalTokens?: number;
	};
};

/** ACP stopReason → 我们的回合结束原因（与 dsh 同口径） */
export function stopReasonToTurnEnd(reason: string | undefined): "done" | "interrupted" | "error" {
	if (reason === "cancelled") return "interrupted";
	if (reason === "refusal") return "error";
	return "done"; // end_turn / max_tokens / max_turn_requests：这轮确实结束了
}

/**
 * prompt 结果里的 usage → 我们的用量事件。
 *
 * `final: true`：这是**这一次模型调用**的最终值，宿主按轮累加（一轮里可能多次调用）。
 * `cacheWrite` opencode 不单独给（写缓存并进 input 计费），留 0 而不是瞎猜。
 */
export function usageEventOf(result: OpencodePromptResult | undefined): EngineEvent | null {
	const usage = result?.usage;
	if (!usage) return null;
	const input = Number(usage.inputTokens ?? 0);
	const output = Number(usage.outputTokens ?? 0);
	const cacheRead = Number(usage.cachedReadTokens ?? 0);
	if (input === 0 && output === 0 && cacheRead === 0) return null;
	return { type: "usage", input, output, cacheRead, cacheWrite: 0, final: true };
}

// ---------------------------------------------------------------------------
// 权限请求
// ---------------------------------------------------------------------------

/**
 * 权限请求 → 我们的审批请求。
 *
 * opencode 的请求体自带 `toolCall.rawInput`（命令原文），所以不像 dsh 那样要靠
 * `rememberToolCall` 补全；`toolFacts` 只用于兜底。
 */
export function permissionApprovalRequest(
	request: OpencodePermissionRequest,
	tool?: ToolFacts | undefined,
): ApprovalRequest {
	const title = request.toolCall?.title ?? tool?.title ?? "opencode 工具调用";
	const args = request.toolCall?.rawInput ?? tool?.rawInput;
	const summary = args === undefined ? "" : safeJson(args);
	const clipped = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
	const kind = request.toolCall?.kind ?? tool?.kind ?? "";
	return {
		toolName: title,
		argsSummary: clipped,
		scopeKey: `opencode|${title}`,
		scopeHint: title,
		riskNote:
			kind === "execute"
				? "opencode 请求执行这条命令；是否放行由你决定"
				: "opencode 请求执行这个操作；是否放行由你决定",
	};
}

/** 我们的三态 → 权限选项 id（优先按 kind 匹配，其次按 optionId 猜） */
export function permissionOptionId(
	options: OpencodePermissionOption[] | undefined,
	decision: "once" | "always" | "deny",
): string {
	const list = options ?? [];
	const byKind = (kinds: string[]): string | null => {
		for (const kind of kinds) {
			const hit = list.find((option) => option.kind === kind);
			if (hit) return hit.optionId;
		}
		return null;
	};
	const picked =
		decision === "deny"
			? (byKind(["reject_once", "reject_always"]) ??
				list.find((option) => /reject|deny|cancel/i.test(option.optionId))?.optionId)
			: (byKind(decision === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) ??
				list.find((option) => /allow|accept|approve/i.test(option.optionId))?.optionId);
	return picked ?? list[0]?.optionId ?? (decision === "deny" ? "reject" : "once");
}

// ---------------------------------------------------------------------------
// opencode export（历史回放 / 统计的数据源）
// ---------------------------------------------------------------------------

type OpencodeExportTokens = {
	total?: number;
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { write?: number; read?: number };
};

type OpencodeExportPart = {
	type?: string;
	text?: string;
	tool?: string;
	callID?: string;
	state?: {
		status?: string;
		input?: unknown;
		output?: unknown;
		title?: string;
		error?: unknown;
		metadata?: { exit?: unknown; truncated?: unknown } | null;
		time?: { start?: number; end?: number } | null;
	} | null;
};

type OpencodeExportMessage = {
	info?: {
		id?: string;
		role?: string;
		time?: { created?: number; completed?: number } | null;
		modelID?: string;
		providerID?: string;
		tokens?: OpencodeExportTokens | null;
		cost?: number;
	};
	parts?: OpencodeExportPart[];
};

export type OpencodeExport = {
	info?: {
		id?: string;
		title?: string;
		directory?: string;
		model?: { id?: string; providerID?: string } | null;
		time?: { created?: number; updated?: number } | null;
		cost?: number;
		tokens?: OpencodeExportTokens | null;
	};
	messages?: OpencodeExportMessage[];
};

const textPartsOf = (message: OpencodeExportMessage, type: string): string =>
	(message.parts ?? [])
		.filter((part) => part.type === type && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("");

/** 工具输出可能放在 `state.output`（字符串）或数组里 */
function outputTextOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return textOfContent(value);
	if (value && typeof value === "object") {
		const record = value as { content?: unknown; text?: string; output?: unknown };
		if (typeof record.output === "string") return record.output;
		const inner = textOfContent(record.content);
		if (inner !== "") return inner;
		if (typeof record.text === "string") return record.text;
	}
	return "";
}

/**
 * export JSON → 对话区消息（历史回放）。
 *
 * 工具块状态直接取 `state.status`（completed → ok，error → failed），
 * 还在跑的（导出时被中断）标 failed，不能留在 running 上骗人。
 */
export function exportToUiMessages(exported: OpencodeExport | null | undefined): UiMessage[] {
	const messages: UiMessage[] = [];
	for (const message of exported?.messages ?? []) {
		const info = message.info ?? {};
		const createdAt = info.time?.created;
		const ts = typeof createdAt === "number" ? createdAt : 0;
		const id = info.id ?? `m-${messages.length}`;
		if (info.role === "user") {
			const text = textPartsOf(message, "text");
			if (text.trim() === "") continue;
			messages.push({ id: `u-${id}`, role: "user", ts, blocks: [{ kind: "text", text }] });
			continue;
		}
		if (info.role !== "assistant") continue;

		const blocks: UiMessage["blocks"] = [];
		for (const part of message.parts ?? []) {
			if (part.type === "reasoning" && typeof part.text === "string" && part.text !== "") {
				blocks.push({ kind: "thinking", text: part.text });
				continue;
			}
			if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
				blocks.push({ kind: "text", text: part.text });
				continue;
			}
			if (part.type === "tool") {
				const state = part.state ?? {};
				const rawInput = state.input === undefined ? "" : safeJson(state.input);
				const output = outputTextOf(state.output);
				const clipped = output.length > TOOL_EXCERPT_CHARS ? `${output.slice(0, TOOL_EXCERPT_CHARS)}…` : output;
				const exit = state.metadata?.exit;
				const status =
					state.status === "completed"
						? "ok"
						: state.status === "error" || state.status === "failed"
							? "failed"
							: "failed";
				blocks.push({
					kind: "tool",
					toolCallId: part.callID ?? `tool-${id}-${blocks.length}`,
					name: (state.title ?? part.tool ?? "tool").trim() || part.tool || "tool",
					argsSummary: rawInput.length > 300 ? `${rawInput.slice(0, 300)}…` : rawInput,
					argsFull: rawInput,
					status,
					outputExcerpt: clipped,
					truncated: output.length > TOOL_EXCERPT_CHARS,
					startedAt: typeof state.time?.start === "number" ? state.time.start : ts,
					endedAt: typeof state.time?.end === "number" ? state.time.end : ts,
					...(typeof exit === "number" ? { exitCode: exit } : {}),
				});
			}
		}
		if (blocks.length === 0) continue;
		const tokens = info.tokens;
		const endedAt = info.time?.completed;
		messages.push({
			id: `a-${id}`,
			role: "assistant",
			ts,
			endedAt: typeof endedAt === "number" ? endedAt : ts,
			blocks,
			...(info.providerID && info.modelID ? { model: `${info.providerID}/${info.modelID}` } : {}),
			...(tokens
				? {
						usage: {
							input: tokens.input ?? 0,
							output: tokens.output ?? 0,
							cacheRead: tokens.cache?.read ?? 0,
							cacheWrite: tokens.cache?.write ?? 0,
							...(typeof info.cost === "number" ? { cost: info.cost } : {}),
						},
					}
				: {}),
		});
	}
	return messages;
}

/** export JSON → 引擎转录（只留正文） */
export function exportToTranscript(exported: OpencodeExport | null | undefined): EngineMessage[] {
	const out: EngineMessage[] = [];
	for (const message of exported?.messages ?? []) {
		const role = message.info?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textPartsOf(message, "text");
		if (text.trim() === "") continue;
		const created = message.info?.time?.created;
		out.push({ role, text, ts: typeof created === "number" ? created : 0 });
	}
	return out;
}

/**
 * 这份导出里最后一条 assistant 是不是「还没记账」？
 *
 * 用在哪里：回合刚结束那一瞬间 `opencode export` 可能已经看得到消息、却**还没有 tokens**
 * （实测会出现 `tokens:{}` 的行）—— 拿它算账会得到「消息数新、token 是上一轮的」这种半截数字。
 * 所以统计遇到 pending 就再等一帧重读，而不是把这个中间态写进面板。
 */
export function hasPendingUsage(exported: OpencodeExport | null | undefined): boolean {
	const assistants = (exported?.messages ?? []).filter((message) => message.info?.role === "assistant");
	const last = assistants.at(-1);
	if (!last) return true; // 连 assistant 都没有：这一轮肯定还没落完
	const tokens = last.info?.tokens;
	if (!tokens) return true;
	const sum =
		(tokens.total ?? 0) +
		(tokens.input ?? 0) +
		(tokens.output ?? 0) +
		(tokens.cache?.read ?? 0) +
		(tokens.cache?.write ?? 0);
	return sum === 0;
}

/**
 * export JSON → 会话统计。
 *
 * 四桶用量来自每条 assistant 的 `info.tokens`（opencode 自己按次记账），
 * 上下文占用取「最后一条 assistant 的 input + cache.read」（近似"当前上下文多大"）。
 */
export function exportStats(exported: OpencodeExport | null | undefined): SessionStats {
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
	for (const message of exported?.messages ?? []) {
		const role = message.info?.role;
		if (role === "user") {
			stats.userMessages += 1;
			stats.totalMessages += 1;
			continue;
		}
		if (role !== "assistant") continue;
		stats.assistantMessages += 1;
		stats.totalMessages += 1;
		for (const part of message.parts ?? []) {
			if (part.type !== "tool") continue;
			stats.toolCalls += 1;
			const status = part.state?.status;
			if (status === "completed" || status === "error" || status === "failed") stats.toolResults += 1;
		}
		const tokens = message.info?.tokens;
		if (!tokens) continue;
		const input = tokens.input ?? 0;
		const cacheRead = tokens.cache?.read ?? 0;
		const cacheWrite = tokens.cache?.write ?? 0;
		const output = tokens.output ?? 0;
		stats.inputTokens += input;
		stats.outputTokens += output;
		stats.cacheRead += cacheRead;
		stats.cacheWrite += cacheWrite;
		stats.totalTokens += tokens.total ?? input + output + cacheRead + cacheWrite;
		// 最后一条 assistant 的输入侧 = 当前上下文占用
		stats.contextTokens = input + cacheRead;
	}
	return stats;
}

// ---------------------------------------------------------------------------
// 错误 → 人话
// ---------------------------------------------------------------------------

export function friendlyOpencodeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT|spawn .* ENOENT|command not found/i.test(message)) {
		return "没有找到 opencode 可执行文件：先安装它（`npm i -g opencode-ai`），或设 AGENT_WEB_OPENCODE_BIN 指向它";
	}
	// 顺序有讲究：opencode 的拒绝理由常是「Invalid params: <东西> not found」，「<东西>」
	// 到底是思考档 / 模型 / 会话，决定了该给人哪一句 —— 所以先认具体的关键字。
	if (/effort|thought_level|thoughtLevel|config option/i.test(message)) {
		return "这个模型不支持该思考档位：换一个模型，或换回默认档";
	}
	if (/model not found|unknown model|model.*invalid|provider.*not found/i.test(message)) {
		return "opencode 里没有这个模型路由：换一个模型（列表来自 opencode 自己的 provider 配置）";
	}
	if (/api key|credential|unauthorized|401|403|no provider|permission denied to use model/i.test(message)) {
		return "这条模型没有凭据或额度：换一个模型，或在终端里跑 `opencode auth login`（本机 opencode 的凭据要单独登录）";
	}
	if (/unknown session|no such session|session not found|not found: ses_/i.test(message)) {
		return "opencode 里找不到这条会话（可能已在 CLI / TUI 里删除）";
	}
	return message;
}
