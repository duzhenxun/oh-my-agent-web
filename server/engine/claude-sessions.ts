/**
 * Claude Code 的**会话存储**（只读解析 + 侧栏清单）：`<CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/<id>.jsonl`。
 *
 * 为什么要自己读 JSONL，而不是让 ACP 适配器回放：
 *   1. `session/load` 是**会重放整段历史**的（每条历史消息都变成一条 `session/update`），
 *      我们只是要看一看历史、不该为此拿一个活的 query 句柄（续接才需要，见 claude.ts 的 resume）；
 *   2. ACP 的 `session/list` 只回 `{sessionId, cwd, title, updatedAt}`，**没有模型和用量**，
 *      而侧栏要显示模型、会话信息面板要显示 token —— 这些都在 JSONL 里；
 *   3. 用量：`session/prompt` 只回 `stopReason`（**没有 usage**），唯一的账本就是这个 JSONL
 *      里每条 assistant 的 `message.usage`。
 *
 * 文件格式（实测 Claude Code 2.1.301）：每行一个 JSON 条目，我们只认这几种：
 *   - `{type:"user", message:{role:"user", content}, timestamp, uuid, cwd, sessionId, isSidechain}`
 *     `content` 是字符串（真人输入）或块数组（`text` / `tool_result`）；
 *   - `{type:"assistant", message:{role:"assistant", content:[text|thinking|tool_use], model, usage}, ...}`
 *     **一次模型调用一条**：一个回合里有工具调用时会有多条，所以界面消息要把连续几条合成一条；
 *   - `{type:"system", subtype:"api_error", error:{message}}`：报错，映射成 error 块；
 *   - `{type:"cost-state", totalCostUSD}`：整段会话花费（最后一次为准）；
 *   - 其余（`queue-operation` / `attachment` / `api-request*` / `last-prompt` / `atis-latch` …）
 *     是内部记账，一律跳过。
 *
 * 目录名编码不可逆（`/a-b` 与 `/a/b` 都编成 `-a-b`），所以**只用它做定位预筛**，
 * 真正的 cwd 一律取条目里的 `cwd` 字段 —— 与适配器 `unstable_listSessions` 的判法一致。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	TOOL_EXCERPT_CHARS,
	type MessageBlock,
	type PiProject,
	type PiSessionSummary,
	type SessionStats,
	type ToolBlock,
	type UiMessage,
} from "../protocol.js";
import { CLAUDE_PROVIDER, summarizeToolInput } from "./claude-map.js";
import type { EngineMessage } from "./port.js";
import { isScratchCwd } from "./scratch.js";

/** 标题上限：与适配器一致（超过就截断加省略号） */
const MAX_TITLE_LENGTH = 128;

/** Claude 的数据目录（`CLAUDE_CONFIG_DIR` 与 claude 本体一致） */
function claudeHome(home?: string): string {
	return home?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** 与 claude-code-acp 的 `encodeProjectPath` 完全一致（不可逆，只用于定位目录） */
function encodeProjectPath(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

type ClaudeContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
};

type ClaudeUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

type ClaudeEntry = {
	type?: string;
	subtype?: string;
	isSidechain?: boolean;
	sessionId?: string;
	cwd?: string;
	uuid?: string;
	timestamp?: string;
	totalCostUSD?: number;
	error?: { message?: string };
	message?: {
		role?: string;
		model?: string;
		content?: string | ClaudeContentBlock[];
		usage?: ClaudeUsage;
	};
};

/** 逐行容忍解析：坏行（历史版本、被截断的行）跳过，不让整个会话消失 */
function parseTranscript(text: string): ClaudeEntry[] {
	const out: ClaudeEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed !== null && typeof parsed === "object") out.push(parsed as ClaudeEntry);
		} catch {
			continue;
		}
	}
	return out;
}

export function readTranscriptFile(file: string): ClaudeEntry[] {
	try {
		return parseTranscript(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

function timestampOf(entry: ClaudeEntry): number {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** 会话 id → 文件（先按 cwd 猜路径，再扫全部项目目录；与适配器的 `findSessionFile` 同序） */
export function claudeSessionFile(
	sessionId: string,
	options: { cwd?: string | null; home?: string } = {},
): string | null {
	if (sessionId.trim() === "") return null;
	const root = join(claudeHome(options.home), "projects");
	const fileName = `${sessionId}.jsonl`;
	if (options.cwd) {
		const expected = join(root, encodeProjectPath(options.cwd), fileName);
		if (existsSync(expected)) return expected;
	}
	let dirs: string[];
	try {
		dirs = readdirSync(root).filter((name) => {
			try {
				return statSync(join(root, name)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return null;
	}
	for (const dir of dirs) {
		const candidate = join(root, dir, fileName);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** 全部会话文件（跳过 `agent-*.jsonl`：那是内部子代理的日志，不是用户会话） */
function listClaudeSessionFiles(home?: string): Array<{ id: string; file: string; mtimeMs: number }> {
	const root = join(claudeHome(home), "projects");
	let dirs: string[];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const out: Array<{ id: string; file: string; mtimeMs: number }> = [];
	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(join(root, dir));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
			const full = join(root, dir, file);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(full).mtimeMs;
			} catch {
				continue;
			}
			out.push({ id: file.slice(0, -".jsonl".length), file: full, mtimeMs });
		}
	}
	return out;
}

function sanitizeTitle(text: string): string {
	const sanitized = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized.length <= MAX_TITLE_LENGTH ? sanitized : `${sanitized.slice(0, MAX_TITLE_LENGTH)}…`;
}

/** 这块内容算不算「真人说的话」（排除工具结果、system-reminder、命令回显） */
function userTextOf(content: string | ClaudeContentBlock[] | undefined): string | null {
	const candidates: string[] =
		typeof content === "string"
			? [content]
			: (content ?? [])
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => block.text as string);
	for (const text of candidates) {
		const trimmed = text.trim();
		if (trimmed === "") continue;
		// 注入的上下文（<system-reminder> / <local-command-stdout> / 工具结果回显）不是用户输入
		if (trimmed.startsWith("<")) continue;
		return sanitizeTitle(trimmed);
	}
	return null;
}

type ClaudeSessionMeta = {
	id: string;
	file: string;
	cwd: string;
	title: string;
	startedAt: number;
	updatedAt: number;
	model: string | null;
};

/** 一条会话的元数据（cwd / 标题 / 起止时间 / 模型）；判不出 cwd 或落在临时目录的返回 null */
function sessionMetaOf(id: string, file: string, entries: ClaudeEntry[], updatedAt: number): ClaudeSessionMeta | null {
	let cwd = "";
	let title: string | null = null;
	let startedAt = 0;
	let model: string | null = null;
	for (const entry of entries) {
		if (entry.isSidechain === true) continue;
		if (cwd === "" && typeof entry.cwd === "string") cwd = entry.cwd;
		if (startedAt === 0) startedAt = timestampOf(entry);
		if (entry.type === "user" && title === null) title = userTextOf(entry.message?.content);
		if (entry.type === "assistant") {
			const found = entry.message?.model;
			if (typeof found === "string" && found !== "" && found !== "<synthetic>") model = found;
		}
	}
	if (cwd === "" || isScratchCwd(cwd)) return null;
	return {
		id,
		file,
		cwd,
		title: title ?? id,
		startedAt: startedAt || updatedAt,
		updatedAt,
		model,
	};
}

/** 纯分组：会话 → 项目（按 cwd；项目名取目录名） */
function groupClaudeSessions(sessions: ClaudeSessionMeta[]): PiProject[] {
	const groups = new Map<string, PiProject>();
	for (const session of sessions) {
		const group =
			groups.get(session.cwd) ??
			({ cwd: session.cwd, name: basename(session.cwd) || session.cwd, sessions: [] } as PiProject);
		const summary: PiSessionSummary = {
			id: session.id,
			engineSessionId: session.id,
			title: session.title,
			startedAt: session.startedAt,
			updatedAt: session.updatedAt,
			cwd: session.cwd,
			model: session.model,
			// 会话的事实源就是这个文件（读历史 / 删除都用它）
			sessionPath: session.file,
		};
		group.sessions.push(summary);
		groups.set(session.cwd, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
		}))
		.sort((left, right) => (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0));
}

/**
 * 侧栏的会话清单（读文件，不开子进程）。
 *
 * 每个文件按 mtime 缓存解析结果：刷新会话列表是高频动作（每次回合结束都会来一次），
 * 但历史文件几乎不变 —— 没有这层缓存就会把几十条会话每条都重新 parse 一遍。
 */
export function createClaudeSessionsProvider(options: {
	home?: string;
	log?: (text: string) => void;
	/** 结果缓存时长（默认 5s；上层刷新本身有最小间隔） */
	cacheMs?: number;
	now?: () => number;
}): () => Promise<PiProject[]> {
	const home = options.home;
	const cacheMs = options.cacheMs ?? 5000;
	const now = options.now ?? Date.now;
	let cached: { at: number; value: PiProject[] } | null = null;
	const fileCache = new Map<string, { mtimeMs: number; meta: ClaudeSessionMeta | null }>();

	return async () => {
		if (cached && now() - cached.at < cacheMs) return cached.value;
		try {
			const sessions: ClaudeSessionMeta[] = [];
			for (const session of listClaudeSessionFiles(home)) {
				const known = fileCache.get(session.file);
				if (known && known.mtimeMs === session.mtimeMs) {
					if (known.meta) sessions.push(known.meta);
					continue;
				}
				const meta = sessionMetaOf(session.id, session.file, readTranscriptFile(session.file), session.mtimeMs);
				fileCache.set(session.file, { mtimeMs: session.mtimeMs, meta });
				if (meta) sessions.push(meta);
			}
			cached = { at: now(), value: groupClaudeSessions(sessions) };
			return cached.value;
		} catch (error) {
			options.log?.(`读取 claude 会话清单失败：${error instanceof Error ? error.message : String(error)}`);
			return cached?.value ?? [];
		}
	};
}

// ---------------------------------------------------------------------------
// JSONL → 界面消息 / 转录 / 统计
// ---------------------------------------------------------------------------

function toolBlockOf(block: ClaudeContentBlock, ts: number): ToolBlock {
	const name = typeof block.name === "string" && block.name !== "" ? block.name : "tool";
	const summary = summarizeToolInput(name, block.input);
	const full = block.input === undefined ? "" : safeJson(block.input);
	return {
		kind: "tool",
		toolCallId: typeof block.id === "string" ? block.id : `tool-${ts}-${name}`,
		name,
		argsSummary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
		...(full !== "" && full !== summary ? { argsFull: full } : {}),
		status: "running",
		outputExcerpt: "",
		truncated: false,
		startedAt: ts,
	};
}

/** 工具结果回填（Claude 把 tool_result 放在**下一条 user 条目**里） */
function applyToolResult(block: ToolBlock | undefined, result: ClaudeContentBlock, ts: number): void {
	if (!block) return;
	const output = outputTextOf(result.content);
	block.status = result.is_error === true ? "failed" : "ok";
	block.outputExcerpt = output.length > TOOL_EXCERPT_CHARS ? `${output.slice(0, TOOL_EXCERPT_CHARS)}…` : output;
	block.truncated = output.length > TOOL_EXCERPT_CHARS;
	block.endedAt = ts || block.startedAt;
}

function outputTextOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => outputTextOf(item))
			.filter((text) => text !== "")
			.join("\n");
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if (record.content !== undefined) return outputTextOf(record.content);
		return safeJson(value);
	}
	return "";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/** 条目的内容块（字符串内容 = 纯文本，没有块可数） */
function contentBlocksOf(entry: ClaudeEntry): ClaudeContentBlock[] {
	const content = entry.message?.content;
	return Array.isArray(content) ? content : [];
}

/**
 * 转录 → 界面消息。
 *
 * 分组规则：**一个回合 = 一条 assistant 消息**。Claude 每调一次模型就写一条 `assistant` 条目，
 * 带工具的一轮会有好几条（调工具前后各一次），界面显示成分开的几条会把「一次回复」切碎；
 * 所以把连续几条合成一条，token 求和，`endedAt` 取最后一条的时间。
 * 中间的 `tool_result`（在 user 条目里）只回填工具卡片，不产生用户消息。
 */
export function transcriptToUiMessages(entries: ClaudeEntry[]): UiMessage[] {
	const out: UiMessage[] = [];
	const tools = new Map<string, ToolBlock>();
	let pending: UiMessage | null = null;

	const flush = (): void => {
		if (pending && pending.blocks.length > 0) out.push(pending);
		pending = null;
	};

	for (const entry of entries) {
		if (entry.isSidechain === true) continue;
		const ts = timestampOf(entry);

		// 报错条目没有 message 字段（只有 error），要在 message 守卫**之前**处理掉
		if (entry.type === "system" && entry.subtype === "api_error") {
			if (!pending) pending = { id: `a-${entry.uuid ?? out.length}`, role: "assistant", ts, blocks: [] };
			const text = entry.error?.message ?? "Claude Code 报了一个错";
			pending.blocks.push({ kind: "error", code: "claude.api_error", message: text });
			pending.endedAt = ts;
			continue;
		}

		const message = entry.message;
		if (!message) continue;

		if (entry.type === "user") {
			const content = message.content;
			let said: string | null = null;
			if (typeof content === "string") {
				said = userTextOf(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_result") {
						const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
						applyToolResult(tools.get(id), block, ts);
						continue;
					}
					if (block.type === "text" && said === null) said = userTextOf([block]);
				}
			}
			if (said !== null) {
				flush();
				out.push({
					id: `u-${entry.uuid ?? out.length}`,
					role: "user",
					ts,
					blocks: [{ kind: "text", text: said }],
				});
			}
			continue;
		}

		if (entry.type !== "assistant") continue;
		if (!pending) {
			pending = { id: `a-${entry.uuid ?? out.length}`, role: "assistant", ts, blocks: [] };
		}
		const blocks: MessageBlock[] = pending.blocks;
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
				blocks.push({ kind: "text", text: block.text });
				continue;
			}
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
				blocks.push({ kind: "thinking", text: block.thinking });
				continue;
			}
			if ((block.type === "tool_use" || block.type === "server_tool_use") && block.name !== "TodoWrite") {
				const tool = toolBlockOf(block, ts);
				tools.set(tool.toolCallId, tool);
				blocks.push(tool);
			}
		}
		const usage = message.usage;
		if (usage) {
			const previous = pending.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			pending.usage = {
				input: previous.input + Number(usage.input_tokens ?? 0),
				output: previous.output + Number(usage.output_tokens ?? 0),
				cacheRead: previous.cacheRead + Number(usage.cache_read_input_tokens ?? 0),
				cacheWrite: previous.cacheWrite + Number(usage.cache_creation_input_tokens ?? 0),
			};
		}
		if (typeof message.model === "string" && message.model !== "" && message.model !== "<synthetic>") {
			pending.model = `${CLAUDE_PROVIDER}/${message.model}`;
		}
		pending.endedAt = ts || pending.endedAt;
	}

	flush();
	return out;
}

/** 转录 → 引擎转录（只留正文，给「续聊」这种只要文本的场合） */
export function transcriptToTranscript(entries: ClaudeEntry[]): EngineMessage[] {
	const out: EngineMessage[] = [];
	for (const entry of entries) {
		if (entry.isSidechain === true) continue;
		const message = entry.message;
		if (!message) continue;
		if (entry.type === "user") {
			const text = userTextOf(message.content);
			if (text !== null) out.push({ role: "user", text, ts: timestampOf(entry) });
			continue;
		}
		if (entry.type !== "assistant") continue;
		const parts: string[] = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "text" && typeof block.text === "string" && block.text !== "") parts.push(block.text);
		}
		if (parts.length === 0) continue;
		out.push({ role: "assistant", text: parts.join("\n\n"), ts: timestampOf(entry) });
	}
	return out;
}

/**
 * 转录 → 会话统计。
 *
 * 四桶用量 = Σ 每条 assistant 的 `message.usage`（Claude 按次记账）；
 * 上下文占用取**最后一条** assistant 的输入侧（含缓存读写），近似「现在上下文多大」；
 * 花费只有 `cost-state` 条目给（`totalCostUSD`），没有就不给这个字段（不编 0）。
 */
export function transcriptStats(entries: ClaudeEntry[]): SessionStats {
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
	for (const entry of entries) {
		if (entry.isSidechain === true) continue;
		if (entry.type === "user") {
			if (userTextOf(entry.message?.content) === null) {
				// 只有工具结果的 user 条目：计入工具结果，不算一条用户消息
				for (const block of contentBlocksOf(entry)) {
					if (block.type === "tool_result") stats.toolResults += 1;
				}
				continue;
			}
			stats.userMessages += 1;
			stats.totalMessages += 1;
			continue;
		}
		if (entry.type !== "assistant") continue;
		stats.assistantMessages += 1;
		stats.totalMessages += 1;
		for (const block of contentBlocksOf(entry)) {
			if (block.type === "tool_use" && block.name !== "TodoWrite") stats.toolCalls += 1;
		}
		const usage = entry.message?.usage;
		if (!usage) continue;
		const input = Number(usage.input_tokens ?? 0);
		const output = Number(usage.output_tokens ?? 0);
		const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
		const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
		stats.inputTokens += input;
		stats.outputTokens += output;
		stats.cacheRead += cacheRead;
		stats.cacheWrite += cacheWrite;
		stats.totalTokens += input + output + cacheRead + cacheWrite;
		stats.contextTokens = input + cacheRead + cacheWrite;
	}
	for (const entry of entries) {
		if (entry.type === "cost-state" && typeof entry.totalCostUSD === "number") {
			stats.cost = entry.totalCostUSD;
		}
	}
	return stats;
}

/**
 * 这一轮的用量（最后一条真人输入之后的全部 assistant 之和）。
 *
 * 用在哪里：`session/prompt` 的返回里没有 usage，宿主却要在这轮结束时报一次账 ——
 * 回合结束时读一遍 JSONL，把这段加起来推一个 `usage` 事件（界面上的 token 才会动）。
 */
export function lastTurnUsage(
	entries: ClaudeEntry[],
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
	let start = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "user" || entry.isSidechain === true) continue;
		if (userTextOf(entry.message?.content) === null) continue;
		start = index;
		break;
	}
	if (start < 0) return null;
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const entry of entries.slice(start + 1)) {
		if (entry.type !== "assistant" || entry.isSidechain === true) continue;
		const usage = entry.message?.usage;
		if (!usage) continue;
		total.input += Number(usage.input_tokens ?? 0);
		total.output += Number(usage.output_tokens ?? 0);
		total.cacheRead += Number(usage.cache_read_input_tokens ?? 0);
		total.cacheWrite += Number(usage.cache_creation_input_tokens ?? 0);
	}
	const sum = total.input + total.output + total.cacheRead + total.cacheWrite;
	return sum === 0 ? null : total;
}

/** 会话最后用的模型（历史会话打开时显示它，而不是「当前默认」） */
export function sessionModelOf(entries: ClaudeEntry[]): { provider: string; model: string } | null {
	let model: string | null = null;
	for (const entry of entries) {
		if (entry.type !== "assistant" || entry.isSidechain === true) continue;
		const found = entry.message?.model;
		if (typeof found === "string" && found !== "" && found !== "<synthetic>") model = found;
	}
	return model === null ? null : { provider: CLAUDE_PROVIDER, model };
}

/**
 * 删除会话：删掉那个 JSONL。
 *
 * Claude 自己的 CLI 没有「删除会话」这个动作（`/clear` 只是开新的），所以这里直接删文件 ——
 * 与「会话的事实源是引擎自己写的文件」一致：文件没了，侧栏与 `claude --resume` 也就找不到了。
 */
export function deleteClaudeSession(
	sessionId: string,
	options: { cwd?: string | null; home?: string; sessionPath?: string | null } = {},
): boolean {
	const file = options.sessionPath || claudeSessionFile(sessionId, options);
	if (!file || !existsSync(file)) return false;
	try {
		rmSync(file, { force: true });
		return true;
	} catch {
		return false;
	}
}
