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
import { open, readFile, readdir, stat, writeFile, rename, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * 只读文件**开头** maxLines 行，不把整个 JSONL 读进内存。
 *
 * 以前 `scansPiSessions` 设了 `maxLinesPerFile = 60`，但实现是 `readFile(path)` + `split("\n")` ——
 * 计数确实只用了前 60 行，**内存却按整个文件算**。一个几十 MB 的旧会话，刷新一次侧栏就把它整个拉进堆里，
 * 247 个会话里只要有几个大文件，列表刷新就变成「越用越慢 + 内存往上走」。
 *
 * 现在按 16KB 块读，数够行数（或碰 maxBytes 上限）就停。返回的行不带换行符。
 *
 * **但一行也不能截断**（用户报的「新会话建好后，上面标题跟左边那个会话名不一样」就是这里）：
 * 粘贴的截图是**内联 base64 存在同一条消息里的**，所以首条用户消息那一行能有几百 KB
 * （实测 278KB），而预算只有 256KB —— 卡在中间截断后 `JSON.parse` 必失败，
 * 这条会话就被当成「没有标题」，标题退化成文件修改时间（`2026/10/28 16:57:51`），
 * 而顶栏用的是服务端内存里的真标题，两处就对不上了。
 * 所以预算用完之后**继续把当前这一行读完**（最多再读 LONG_LINE_BYTES）；
 * 实在读到硬上限还没结束，就把这半行丢掉 —— 宁可少一个标题，也不要拿半截 JSON 冒充一行。
 */
async function readHeadLines(path: string, maxLines: number, maxBytes = HEAD_BYTES): Promise<string[]> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(16 * 1024);
		const chunks: Buffer[] = [];
		let size = 0;
		let newlines = 0;
		/** 最后一块是不是以换行收尾（= 手上这些行都是完整的） */
		let endedWithNewline = false;
		let atEof = false;
		const pull = async () => {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
			if (bytesRead === 0) {
				atEof = true;
				return;
			}
			// 必须拷贝：下一轮 read 会覆盖同一个 buffer
			const chunk = Buffer.from(buffer.subarray(0, bytesRead));
			chunks.push(chunk);
			size += bytesRead;
			for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === 10) newlines += 1;
			endedWithNewline = chunk[chunk.length - 1] === 10;
		};
		// 正常预算：数够行数就停（绝大多数会话读十几 KB 就够）
		while (newlines < maxLines && size < maxBytes && !atEof) await pull();
		// 预算用完却卡在一行中间：继续读到这一行结束（硬上限防病态大文件）
		const hardLimit = Math.max(maxBytes, LONG_LINE_BYTES);
		while (newlines < maxLines && !atEof && !endedWithNewline && size < hardLimit) await pull();
		// 只在最后解码一次：多字节字符被块边界切开也不会碎
		const text = Buffer.concat(chunks).toString("utf8");
		const lines = text.split("\n");
		// 硬上限到了还没结束 = 半行：丢掉。EOF 且无结尾换行时最后一行是完整的，别误删
		if (!atEof && newlines < maxLines && !endedWithNewline) lines.pop();
		return lines.slice(0, maxLines);
	} finally {
		await handle.close();
	}
}

/**
 * 只读文件**末尾**一段（用于 model_change / session_info 这两个「追加式」信息）。
 * 起点可能切在行中间，那条半行 JSON.parse 会失败 → 跳过，不影响结果。
 */
async function readTailLines(path: string, maxBytes = TAIL_BYTES): Promise<string[]> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.allocUnsafe(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return buffer.subarray(0, read).toString("utf8").split("\n");
	} finally {
		await handle.close();
	}
}

/** 扫描时头/尾各读多少（头：前 60 行；尾：末尾的 model_change + session_info） */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
/**
 * 头部读取的硬上限：为了把**一行**读完能多读到这儿。
 * 首条消息里内联的截图（base64）实测 278KB，给到 4MB 足够任何正常截图，
 * 又不至于为了一个坏文件把整个会话读进内存。
 */
const LONG_LINE_BYTES = 4 * 1024 * 1024;

export const PI_AGENT_DIR_ENV = "PI_AGENT_DIR";

/** 列表里一行会话 */
type PiSessionRow = {
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

type PiProjectGroup = {
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
function parseSessionHeader(line: string): { id: string; cwd: string; startedAt: number } | null {
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
 * 会话名（session_info）也一样倒着找 —— **改名是往文件末尾追加一条**，
 * 只扫开头的话，超过 60 行的会话改完名界面上永远看不到变化（"改名改不了"那个 bug）。
 */
function extractListMeta(lines: string[], headLimit = lines.length): { title: string; model: string | null } {
	let title = "";
	let model: string | null = null;

	for (const [index, line] of lines.entries()) {
		// 标题只扫开头；模型 / 会话名在下面单独倒着找
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
		if (title) continue;
		if (record.type !== "message") continue;
		const message = record.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "user") continue;
		title = textOfMessageContent(message.content);
	}

	/** pi 自己的会话名（session_info.name）：有它就以它为准，首条消息只当兜底 */
	const name = lastSessionName(lines);

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

/**
 * 最后一条 `session_info.name`（改名 = 往文件末尾再追加一条，所以要从后往前找）。
 * 只对含关键字的行 JSON.parse —— 会话文件动辄几千行，全量解析太贵。
 */
function lastSessionName(lines: string[]): string {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (!line.includes("session_info")) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type !== "session_info") continue;
		if (typeof record.name !== "string" || record.name.trim() === "") continue;
		return record.name;
	}
	return "";
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
	// 认不出 cwd（空 / 脏数据）时它就是一个「不属于任何已知项目」的组，
	// 叫「未分组」比叫「未知项目」诚实：我们确实不知道它在哪个项目，而不是猜错一个名字。
	if (cwd === "") return "未分组";
	// 不能 split("/")：Windows 的 `C:\Users\x\proj` 切不开，项目名会变成整条路
	const name = basename(cwd);
	return name === "" ? cwd : name;
}

/**
 * 纯函数：把扁平会话列表按 cwd 分组。
 *
 * 组内按 **startedAt（创建时间）倒序**：新会话在最上面，而**更新一个旧会话不会让它跳位置** ——
 * 按 updatedAt 排的话，你在一个老会话里说一句话它就窜到最上面，整个列表跟着挪，很烦人。
 * 组间仍按最新活动倒序（侧栏会用 projectPrefs 再排一次，这里只保证可预期的初始顺序）。
 */
function groupByProject(sessions: PiSessionRow[]): PiProjectGroup[] {
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

/**
 * 缓存格式版本。**改了「怎么从文件里抠标题」就要加这个数** —— 否则旧缓存里那些
 * 「标题退化成时间戳」的行会一直沿用下去（文件的 mtime 没变就不会重读）。
 * v2：首条消息带内联截图（一行几百 KB）时不再被截断，标题重新能读出来。
 */
export const CACHE_VERSION = 2;

function parseCache(text: string): PiSessionsCache {
	try {
		const parsed = JSON.parse(text) as PiSessionsCache;
		if (parsed && typeof parsed === "object" && parsed.v === CACHE_VERSION && parsed.entries) return parsed;
	} catch {
		// 坏缓存 = 没有缓存（ADR-0005 的同款纪律：缓存坏了不该致命）
	}
	return { v: CACHE_VERSION, entries: {} };
}

type ScanOptions = {
	sessionsRoot: string;
	/** 之前扫描的缓存（按 path+mtime 复用，避免每次刷新都重读文件） */
	cache?: PiSessionsCache;
	/** 每个文件最多读多少行来找标题/模型 */
	maxLinesPerFile?: number;
	/** 只扫最近 N 个（按 mtime），默认不限 */
	limit?: number;
};

type ScanResult = {
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
			/**
			 * 只读**头 60 行**找标题，再读**末尾一段**找 model_change / session_info。
			 *
			 * 两段的顺序就是文件顺序（头在前、尾在后），所以 `extractListMeta` 不用改签名：
			 * 标题扫描被 `headLimit` 限在前 60 行 → 只看头；模型/会话名从**末尾倒着找** → 落在尾部。
			 * 这样既不再把整个 JSONL 读进内存，又真的能读到「改名」和「中途换模型」
			 * （以前只传头部，超过 60 行的会话改名后界面上永远看不到变化）。
			 */
			let headLines: string[];
			let tailLines: string[];
			try {
				[headLines, tailLines] = await Promise.all([readHeadLines(path, maxLines), readTailLines(path)]);
			} catch {
				continue;
			}
			const header = parseSessionHeader(headLines[0] ?? "");
			if (!header) continue; // 不是会话文件

			const meta = extractListMeta([...headLines.slice(1), ...tailLines], maxLines - 1);
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

// ---------------------------------------------------------------------------
// 会话搬家（把一条会话移到另一个项目）
// ---------------------------------------------------------------------------

/**
 * 纯函数：把 cwd 编码成 pi 会话存储里的目录名（与 SDK 的 `getDefaultSessionDir` 同款算法）。
 *
 * SDK 的编码（`session-manager.js`）：`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`。
 * 这里**不 import SDK**（ADR-0003：只有 `server/engine` 能碰 SDK），只复刻这一个确定性编码。
 */
function encodeSessionCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * 把一条会话文件搬到另一个项目：重写首行 header 的 `cwd`，再把文件移到新项目的会话目录。
 *
 * 会话文件是 append-only JSONL，首行就是 header；只改这一行的 `cwd` 字段，
 * 其余字节原样保留（历史 / 分支 / session_info 都不动）。落盘走「写临时文件 + 原子改名」
 * （同 `writeCacheFile` 的纪律），最后用 rename 把文件挪到 `<sessionsRoot>/<encoded newCwd>/`。
 *
 * @returns 搬家后的会话文件绝对路径
 */
export async function moveSessionFile(sessionsRoot: string, sessionPath: string, newCwd: string): Promise<string> {
	const raw = await readFile(sessionPath, "utf8");
	const newlineAt = raw.indexOf("\n");
	const firstLine = newlineAt === -1 ? raw : raw.slice(0, newlineAt);
	const rest = newlineAt === -1 ? "" : raw.slice(newlineAt + 1);

	let header: Record<string, unknown>;
	try {
		header = JSON.parse(firstLine) as Record<string, unknown>;
	} catch {
		throw new Error("会话文件首行不是合法 header");
	}
	if (header.type !== "session") throw new Error("会话文件首行不是会话 header");
	header.cwd = newCwd;

	const targetDir = join(sessionsRoot, encodeSessionCwdDir(newCwd));
	await mkdir(targetDir, { recursive: true });
	const targetPath = join(targetDir, basename(sessionPath));
	const temporary = `${targetPath}.moving-${process.pid}-${Date.now()}`;
	// 原文件 = 首行 header + "\n" + 其余字节；只把首行换成新 header，其余原样保留
	await writeFile(temporary, `${JSON.stringify(header)}${rest ? `\n${rest}` : ""}`, "utf8");
	await rename(temporary, targetPath);
	// 源文件已在新位置就位，删掉旧文件（搬家，不是复制）
	if (targetPath !== sessionPath) {
		await rename(sessionPath, `${sessionPath}.moved-${Date.now()}`).catch(() => undefined);
	}
	return targetPath;
}
