/**
 * pi 会话列表的「扫描 + 缓存」提供者（ADR-0021 §1）——从 index.ts 抽出（400 行护栏）。
 *
 * 首扫要读 247 个文件（实测 ~1s），之后靠 path+mtime 缓存（~7ms）；
 * 缓存落在 `<dataDir>/pi-sessions-cache.json`，坏了就重扫（ADR-0005 的同款纪律）。
 */
import {
	CACHE_VERSION,
	PI_AGENT_DIR_ENV,
	readCacheFile,
	scanPiSessions,
	writeCacheFile,
	type PiSessionsCache,
} from "./pi-sessions.js";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi 的配置目录（与 SDK 的 getAgentDir 默认值一致；这里不 import SDK —— 边界守则见 ADR-0003） */
export function piAgentDir(): string {
	return process.env[PI_AGENT_DIR_ENV] ?? join(homedir(), ".pi", "agent");
}
import type { PiProject } from "../protocol.js";

export type Logger = { info: (message: string, ctx?: Record<string, unknown>) => void };

export function createPiSessionsProvider(options: {
	agentDir: string;
	dataDir: string;
	logger: Logger;
}): () => Promise<PiProject[]> {
	let cache: PiSessionsCache = { v: CACHE_VERSION, entries: {} };
	const cacheFile = join(options.dataDir, "pi-sessions-cache.json");
	let loaded = false;

	return async () => {
		if (!loaded) {
			cache = await readCacheFile(cacheFile);
			loaded = true;
		}
		const result = await scanPiSessions({ sessionsRoot: join(options.agentDir, "sessions"), cache });
		cache = result.cache;
		if (result.read > 0) await writeCacheFile(cacheFile, cache).catch(() => {});
		options.logger.info("已读取 pi 已有会话", {
			projects: result.groups.length,
			sessions: result.total,
			read: result.read,
		});
		return result.groups.map((group) => ({
			cwd: group.cwd,
			name: group.name,
			sessions: group.sessions.map((session) => ({
				id: session.id,
				title: session.title,
				startedAt: session.startedAt,
				sessionPath: session.path,
				updatedAt: session.updatedAt,
				cwd: session.cwd,
				model: session.model,
			})),
		}));
	};
}
