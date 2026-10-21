/**
 * 读取 pi 已有的会话（ADR-0021 §1）：只读 + 缓存。
 *
 * pi 的存储布局（实测 2026-10-16，本机 17 个项目 / 247 个会话）：
 *   ~/.pi/agent/sessions/<编码后的 cwd>/<ISO 时间>_<uuid>.jsonl
 *   首行：{"type":"session","version":3,"id":…,"timestamp":…,"cwd":"/abs/path"}
 *
 * 关键取舍：**只读首行 header + 前若干行找标题**，不解析整个文件。
 * 247 个文件全量解析会明显变慢，而列表只需要「项目 / 标题 / 时间」。
 */
import { readFile, readdir, stat, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PI_AGENT_DIR_ENV = "PI_AGENT_DIR";

/** 列表里一行会话 */
export type PiSessionRow = {
	/** SDK 会话 id（header 里的 id） */
	id: string;
	/** 会话文件绝对路径（用于「打开并继续」） */
	path: string;
	/** 该会话的工作目录（header 里的 cwd；老会话可能为空） */
	cwd: string;
	/** 会话开始时间（header timestamp，毫秒） */
	startedAt: number;
	/** 最后活动时间（文件 mtime，毫秒） */
	updatedAt: number;
	/** 标题：首条 user 消息的前若干字（取不到则用时间） */
	title: string;
	/** 模型（能从 model_change 条目里读到就给） */
	model: string | null;
};

export type PiProjectGroup = {
	cwd: string;
	/** 组名：cwd 的最后一段（如 inke.activity.service） */
	name: string;
	sessions: PiSessionRow[];
	updatedAt: number;
};

export function defaultPiSessionsRoot(agentDir: string): string {
	return join(agentDir, "sessions");
}

/** 纯函数：解析首行 header；不是会话文件就返回 null */
export function parseSessionHeader(line: string): { id: string; cwd: string; startedAt: number } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "session") return null;
	const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
	return {
		id: typeof record.id === "string" ? record.id : "",
		cwd: typeof record.cwd === "string" ? record.cwd : "",
		startedAt: Number.isFinite(timestamp) ? timestamp : 0,
	};
}

/**
 * 纯函数：从会话内容行里抠出标题与模型。
 *
 * 标题只看开头（`headLimit` 行）：首条消息就够了，全量扫会慢。
 * 模型**从末尾倒着找**最后一条 `model_change`：追加式文件里那就是「现在用哪个」，
 * 只扫开头会把「中途换过模型」的会话报成最初那个（切回去时选择器就显示错了）。
 */
export function extractListMeta(lines: string[], headLimit = lines.length): { title: string; model: string | null } {
	/** pi 自己的会话名（session_info.name）：有它就以它为准，首条消息只当兜底 */
	let name = "";
	let title = "";
	let model: string | null = null;

	for (const [index, line] of lines.entries()) {
		// 标题/名字只扫开头；模型那一段继续扫到底（下面单独倒着找，这里先跳过）
		if (index >= headLimit) break;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type === "model_change" && typeof record.modelId === "string") {
			// 追加式文件：后来的 model_change 覆盖先前的 —— 会话中途换过模型就要取最后一次，
			// 否则切回这个会话时选择器显示的还是它最初那个模型
			const provider = typeof record.provider === "string" ? record.provider : "";
			model = provider ? `${provider}/${record.modelId}` : record.modelId;
		}
		if (record.type === "session_info" && typeof record.name === "string" && record.name.trim() !== "") {
			name = record.name; // 后写的覆盖先写的（追加式，最新一条生效）
			continue;
		}
		if (title) continue;
		if (record.type !== "message") continue;
		const message = record.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "user") continue;
		title = textOfMessageContent(message.content);
	}

	// 模型：倒着找最后一条 model_change（只解析含关键字的行，避免整文件 JSON.parse）
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (!line.includes("model_change")) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type !== "model_change" || typeof record.modelId !== "string" || record.modelId === "") continue;
		const provider = typeof record.provider === "string" ? record.provider : "";
		model = provider ? `${provider}/${record.modelId}` : record.modelId;
		break;
	}

	// 列表只显示一行：折叠换行/连续空白（首条消息常是多行任务描述）
	const display = (name || title).replace(/\s+/g, " ").trim();
	return { title: display.slice(0, 60), model };
}

function textOfMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : {};
			return typeof record.text === "string" ? record.text : "";
		})
		.join(" ");
}

/** 纯函数：规范化 cwd —— 必须是绝对路径，否则视为「未知」（老会话里出现过 cwd=一句提示词） */
export function normalizeCwd(cwd: string): string {
	const trimmed = cwd.trim();
	if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
	return "";
}

/** 组名：cwd 的最后一段（`/a/b/inke.activity.service` → `inke.activity.service`） */
export function projectNameOf(cwd: string): string {
	if (cwd === "") return "（未知项目）";
	const parts = cwd.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

/**
 * 纯函数：把扁平会话列表按 cwd 分组。
 *
 * 组内按 **startedAt（创建时间）倒序**：新会话在最上面，而**更新一个旧会话不会让它跳位置** ——
 * 按 updatedAt 排的话，你在一个老会话里说一句话它就窜到最上面，整个列表跟着挪，很烦人。
 * 组间仍按最新活动倒序（侧栏会用 projectPrefs 再排一次，这里只保证可预期的初始顺序）。
 */
export function groupByProject(sessions: PiSessionRow[]): PiProjectGroup[] {
	const groups = new Map<string, PiProjectGroup>();
	for (const session of sessions) {
		const key = session.cwd;
		const existing = groups.get(key);
		if (existing) {
			existing.sessions.push(session);
			existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
		} else {
			groups.set(key, {
				cwd: key,
				name: projectNameOf(key),
				sessions: [session],
				updatedAt: session.updatedAt,
			});
		}
	}
	const list = [...groups.values()];
	for (const group of list) group.sessions.sort((a, b) => b.startedAt - a.startedAt);
	return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// 缓存 + 扫描（I/O）
// ---------------------------------------------------------------------------

export type PiSessionsCache = {
	v: number;
	entries: Record<string, { mtimeMs: number; row: PiSessionRow }>;
};

export const CACHE_VERSION = 1;

export function parseCache(text: string): PiSessionsCache {
	try {
		const parsed = JSON.parse(text) as PiSessionsCache;
		if (parsed && typeof parsed === "object" && parsed.v === CACHE_VERSION && parsed.entries) return parsed;
	} catch {
		// 坏缓存 = 没有缓存（ADR-0005 的同款纪律：缓存坏了不该致命）
	}
	return { v: CACHE_VERSION, entries: {} };
}

export type ScanOptions = {
	sessionsRoot: string;
	/** 之前扫描的缓存（按 path+mtime 复用，避免每次刷新都重读文件） */
	cache?: PiSessionsCache;
	/** 每个文件最多读多少行来找标题/模型 */
	maxLinesPerFile?: number;
	/** 只扫最近 N 个（按 mtime），默认不限 */
	limit?: number;
};

export type ScanResult = {
	groups: PiProjectGroup[];
	cache: PiSessionsCache;
	/** 真读了内容的文件数（用于诊断「缓存是否生效」） */
	read: number;
	/** 扫描到的会话总数 */
	total: number;
};

export async function scanPiSessions(options: ScanOptions): Promise<ScanResult> {
	const maxLines = options.maxLinesPerFile ?? 60;
	const cache: PiSessionsCache = { v: CACHE_VERSION, entries: {} };
	const rows: PiSessionRow[] = [];
	let read = 0;

	let projectDirs: string[] = [];
	try {
		const entries = await readdir(options.sessionsRoot, { withFileTypes: true });
		projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(options.sessionsRoot, entry.name));
	} catch {
		// 目录不存在（没装 pi 或没跑过）= 空列表，不是错误
		return { groups: [], cache, read: 0, total: 0 };
	}

	for (const dir of projectDirs) {
		let files: string[] = [];
		try {
			files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const name of files) {
			const path = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = (await stat(path)).mtimeMs;
			} catch {
				continue; // 文件刚被删（用户在 CLI 里清理过）→ 跳过而不是崩
			}

			const cached = options.cache?.entries[path];
			if (cached && cached.mtimeMs === mtimeMs) {
				cache.entries[path] = cached;
				rows.push(cached.row);
				continue;
			}

			read += 1;
			let text = "";
			try {
				text = await readFile(path, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			const header = parseSessionHeader(lines[0] ?? "");
			if (!header) continue; // 不是会话文件

			const meta = extractListMeta(
				lines.filter((line, index) => index > 0),
				maxLines - 1,
			);
			const row: PiSessionRow = {
				id: header.id || name,
				path,
				// 脏数据防御：老会话里出现过 cwd=一句提示词 → 非绝对路径一律当未知项目，避免侧栏出现「组名是一句话」
				cwd: normalizeCwd(header.cwd),
				startedAt: header.startedAt,
				updatedAt: mtimeMs,
				title: meta.title || new Date(mtimeMs || header.startedAt).toLocaleString(),
				model: meta.model,
			};
			rows.push(row);
			cache.entries[path] = { mtimeMs, row };
		}
	}

	const limited = options.limit ? rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, options.limit) : rows;
	return { groups: groupByProject(limited), cache, read, total: rows.length };
}

export async function readCacheFile(file: string): Promise<PiSessionsCache> {
	try {
		return parseCache(await readFile(file, "utf8"));
	} catch {
		return { v: CACHE_VERSION, entries: {} };
	}
}

export async function writeCacheFile(file: string, cache: PiSessionsCache): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	await writeFile(temporary, `${JSON.stringify(cache)}\n`, "utf8");
	await rename(temporary, file); // 原子替换（同 ADR-0005 的索引写法）
}
