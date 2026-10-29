/**
 * DSH 的「项目 / 会话清单」提供者（对齐 DSH 原生：项目 = workspace，会话 = session）。
 *
 * 数据来源（只读）：
 *   - `<DSH_HOME>/storages/workspace.json` —— 原生 workspace：path / title / sessionIds，
 *     以及全局的 pinned / archived 会话 id；
 *   - `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` —— 会话投影缓存：
 *     标题、最后提问时间、最近用的模型（**免解压日志**的快路径）；
 *   - `<DSH_HOME>/sessions/<group>/<session-id>/session.v4.jsonl.zstd` —— 会话日志本身：
 *     拿 header（cwd/createdAt）与 `session/title`，缓存里没有时兜底。
 *
 * 为什么要自己扫目录：ACP 的 `session/list` 只回 `{sessionId, cwd}`，**没有标题和时间**；
 * 侧栏需要标题/时间/模型，所以直接读 DSH 自己的持久化，并额外用 workspace.json 与投影
 * 缓存，避免每个会话都解压日志）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PiProject, PiSessionSummary } from "../protocol.js";
import { firstUserText, locateSessionFile, readSessionHeader, readSessionLog, sessionTitle } from "./dsh-log.js";
import { isScratchCwd } from "./scratch.js";

type DshWorkspaceRow = {
	path?: string;
	title?: string;
	sessionIds?: string[];
	createdAt?: string;
	updatedAt?: string;
};

type DshWorkspaceFile = {
	global?: {
		workspaceIds?: string[];
		defaultWorkspaceId?: string;
		pinnedSessionIds?: string[];
		archivedSessionIds?: string[];
	};
	tables?: { workspaces?: Record<string, DshWorkspaceRow> };
};

/** 投影缓存里我们用到的那几行（其余行忽略，不为它写类型） */
type DshProjCache = {
	record?: {
		identity?: { cwd?: string; createdAt?: number };
		rows?: {
			title?: { val?: unknown };
			sessionListMetadata?: { val?: { lastPromptAt?: unknown } };
			modelSelection?: { val?: { lastUsed?: { provider?: unknown; model?: unknown } } };
		};
	};
};

type DshSessionMeta = {
	id: string;
	cwd: string;
	title: string;
	/** 毫秒 */
	startedAt: number;
	updatedAt: number;
	model: string | null;
};

/** 读 workspace.json；没有/坏了都返回空表（侧栏退回按 cwd 分组） */
function readWorkspaces(home: string): DshWorkspaceFile {
	const file = join(home, "storages", "workspace.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as DshWorkspaceFile;
	} catch {
		return {};
	}
}

/** workspace.json → path → 项目名（title 优先，缺了用目录名） */
function workspaceNames(workspaces: DshWorkspaceFile): Map<string, string> {
	const out = new Map<string, string>();
	for (const row of Object.values(workspaces.tables?.workspaces ?? {})) {
		const path = row.path?.trim();
		if (!path) continue;
		out.set(path, row.title?.trim() || basename(path) || path);
	}
	return out;
}

/** projcache 一条会话的元数据（标题/时间/模型，免解压） */
function readProjCache(
	home: string,
	sessionId: string,
): {
	title: string | null;
	updatedAt: number | null;
	cwd: string | null;
	startedAt: number | null;
	model: string | null;
} {
	const file = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
	if (!existsSync(file)) return { title: null, updatedAt: null, cwd: null, startedAt: null, model: null };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as DshProjCache;
		const rows = parsed.record?.rows;
		const title = rows?.title?.val;
		const lastPromptAt = rows?.sessionListMetadata?.val?.lastPromptAt;
		const lastUsed = rows?.modelSelection?.val?.lastUsed;
		const model =
			typeof lastUsed?.provider === "string" && typeof lastUsed?.model === "string"
				? `${lastUsed.provider}/${lastUsed.model}`
				: null;
		return {
			title: typeof title === "string" && title.trim() !== "" ? title.trim() : null,
			updatedAt: typeof lastPromptAt === "number" ? lastPromptAt : null,
			cwd: parsed.record?.identity?.cwd ?? null,
			startedAt: typeof parsed.record?.identity?.createdAt === "number" ? parsed.record.identity.createdAt : null,
			model,
		};
	} catch {
		return { title: null, updatedAt: null, cwd: null, startedAt: null, model: null };
	}
}

/** 会话目录名就是会话 id（`session-<uuid>`） */
function sessionDirs(sessionsRoot: string): Array<{ id: string; file: string; mtimeMs: number }> {
	if (!existsSync(sessionsRoot)) return [];
	const out: Array<{ id: string; file: string; mtimeMs: number }> = [];
	let groups;
	try {
		groups = readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const group of groups) {
		if (!group.isDirectory()) continue;
		const groupDir = join(sessionsRoot, group.name);
		let entries;
		try {
			entries = readdirSync(groupDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
			const file = locateSessionFile(sessionsRoot, entry.name, undefined);
			if (!file) continue;
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(file).mtimeMs;
			} catch {
				continue;
			}
			out.push({ id: entry.name, file, mtimeMs });
		}
	}
	return out;
}

/** 日志兜底读取（每个文件按 mtime 缓存，扫描侧栏时不反复解压） */
const logCache = new Map<string, { mtimeMs: number; cwd: string; title: string | null; createdAt: number }>();

function logMeta(file: string, mtimeMs: number): { cwd: string; title: string | null; createdAt: number } {
	const known = logCache.get(file);
	if (known && known.mtimeMs === mtimeMs) return known;
	const header = readSessionHeader(file);
	let title: string | null = null;
	try {
		const log = readSessionLog(file);
		title = sessionTitle(log) ?? firstUserText(log);
	} catch {
		title = null;
	}
	const entry = {
		mtimeMs,
		cwd: typeof header?.cwd === "string" ? header.cwd : "",
		title,
		createdAt: typeof header?.createdAt === "number" ? header.createdAt : 0,
	};
	logCache.set(file, entry);
	return entry;
}

/** 会话 id（`session-<uuid>`）→ 统一成侧栏用的 id（等于目录名，ACP 也认这个） */
function summaryOf(home: string, session: { id: string; file: string; mtimeMs: number }): DshSessionMeta | null {
	const cache = readProjCache(home, session.id);
	const fallback = cache.cwd && cache.title ? null : logMeta(session.file, session.mtimeMs);
	const cwd = cache.cwd ?? fallback?.cwd ?? "";
	if (cwd === "" || isScratchCwd(cwd)) return null;
	return {
		id: session.id,
		cwd,
		title: cache.title ?? fallback?.title ?? session.id,
		startedAt: cache.startedAt ?? fallback?.createdAt ?? session.mtimeMs,
		updatedAt: cache.updatedAt ?? session.mtimeMs,
		model: cache.model,
	};
}

/** 纯分组：会话 → 项目（workspace 的 path 精确匹配；否则按 cwd 单独成组） */
function groupDshSessions(
	sessions: DshSessionMeta[],
	names: Map<string, string>,
	options: { archived?: Set<string> } = {},
): PiProject[] {
	const groups = new Map<string, { cwd: string; name: string; sessions: PiSessionSummary[] }>();
	for (const session of sessions) {
		if (options.archived?.has(session.id)) continue;
		const key = session.cwd;
		const group = groups.get(key) ?? {
			cwd: session.cwd,
			name: names.get(session.cwd) ?? basename(session.cwd) ?? session.cwd,
			sessions: [] as PiSessionSummary[],
		};
		group.sessions.push({
			id: session.id,
			engineSessionId: session.id,
			title: session.title,
			startedAt: session.startedAt,
			updatedAt: session.updatedAt,
			cwd: session.cwd,
			model: session.model,
		});
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => ({
			cwd: group.cwd,
			name: group.name,
			sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
		}))
		.sort((left, right) => (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0));
}

export function createDshSessionsProvider(options: {
	home?: string;
	log?: (text: string) => void;
	/** 结果缓存时长（默认 5s；上层刷新本身有最小间隔） */
	cacheMs?: number;
	now?: () => number;
}): () => Promise<PiProject[]> {
	const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const cacheMs = options.cacheMs ?? 5000;
	const now = options.now ?? Date.now;
	let cached: { at: number; value: PiProject[] } | null = null;

	return async () => {
		if (cached && now() - cached.at < cacheMs) return cached.value;
		try {
			const workspaces = readWorkspaces(home);
			const names = workspaceNames(workspaces);
			const archived = new Set(workspaces.global?.archivedSessionIds ?? []);
			const sessions = sessionDirs(join(home, "sessions"))
				.map((session) => summaryOf(home, session))
				.filter((session): session is DshSessionMeta => session !== null);
			const value = groupDshSessions(sessions, names, { archived });
			cached = { at: now(), value };
			return value;
		} catch (error) {
			options.log?.(`读取 dsh 会话清单失败：${error instanceof Error ? error.message : String(error)}`);
			return cached?.value ?? [];
		}
	};
}
