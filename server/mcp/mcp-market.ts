/**
 * MCP 市场：从公开注册中心拉一批服务器，给「一键添加」用。
 *
 * 只留两个**能真的装得下**的源，再加一个官方参考服务器目录：
 *
 *   - `registry`：官方 MCP 注册中心 `registry.modelcontextprotocol.io`。
 *     条目里直接给 npm / PyPI 包名与远程地址，所以能拼出**真能跑**的命令；
 *     缺点：带 `search` 的查询在服务端要 20 秒上下（实测），必须长超时 + 缓存。
 *   - `smithery`：Smithery 的开放 API。只取 `remote` 的条目，拼成官方托管地址
 *     `https://server.smithery.ai/<name>/mcp`（实测返回 401 + OAuth 元数据，
 *     也就是 pi 能走 OAuth 登录，不是坏地址）。
 *     刻意**不走** `@smithery/<name>` 那条 npx 写法：那个包在 npm 上不存在
 *     （`npm view @smithery/brave` → 404），一键添加只会得到一条连不上的配置。
 *   - `github`：`modelcontextprotocol/servers` 的 `src/` 目录（`@modelcontextprotocol/server-*`）。
 *
 * 三条纪律：
 *   - **能装才列**：拼不出 command / url 的条目直接丢掉，不用「一键添加」骗人点；
 *   - **网络失败不当机**：1 小时磁盘缓存，失败时回退到旧缓存并说明；
 *   - **不静默改配置**：这里只产出「建议条目」，写文件仍走 `mcp-store.act` 那条路。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dedupeByName, filterEntries, githubEntries, registryEntries, smitheryEntries } from "./mcp-market-sources.js";
import type { MarketEntry, MarketResult, McpMarketSource } from "./mcp-market-types.js";

export { MARKET_SOURCES } from "./mcp-market-types.js";
export type { MarketEntry, MarketResult, McpMarketSource } from "./mcp-market-types.js";

const TIMEOUT_MS = 25_000;
/** 注册中心的 `search=` 实测 40–50 秒（不是网络问题，是它自己慢），搜索单独放宽 */
const SEARCH_TIMEOUT_MS = 70_000;
/** 注册中心的 search 查询实测 20 秒级，缓存久一点（1 小时） */
const CACHE_TTL_MS = 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// ---------------------------------------------------------------------------
// 缓存与抓取
// ---------------------------------------------------------------------------

/**
 * 为什么不用注册中心的 `search=`：实测一次 40–50 秒（`?search=git` 41.6s、
 * `?search=memory` 44.6s），放进交互界面就是「点了没反应」。所以注册中心只按游标翻几页
 * （每页 100 条、约 1.5–3.5 秒），缓存整份后在本地过滤；Smithery 的 `q` 是一秒级的，就用它的。
 */
const REGISTRY_PAGES = 3;

type CacheEnvelope = { timestamp: number; entries: MarketEntry[] };

export type McpMarket = {
	list: (input: { source: McpMarketSource; query?: string; refresh?: boolean }) => Promise<MarketResult>;
};

function githubToken(): string | undefined {
	const value = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

export function createMcpMarket(options: { dataDir: string; fetchImpl?: typeof fetch }): McpMarket {
	const cacheDir = join(options.dataDir, "mcp-market");
	const fetchImpl = options.fetchImpl ?? fetch;

	/**
	 * 缓存键：注册中心 / GitHub 缓存**全量**（搜索在本地做，一个句子一个键会撑爆缓存）；
	 * Smithery 的搜索是服务端做的，按查询词分键（它快，缓存命中率也高）。
	 */
	function cacheKeyOf(source: McpMarketSource, query: string): string {
		const q = query.trim();
		// GitHub 只有那几条，永远本地过滤；注册中心与 Smithery 的搜索都是服务端做的，按词分键
		if (q === "" || source === "github") return source;
		return `${source}-${createHash("sha1").update(q).digest("hex").slice(0, 10)}`;
	}

	function readCache(key: string, allowStale: boolean): MarketEntry[] | null {
		const path = join(cacheDir, `${key}.json`);
		if (!existsSync(path)) return null;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
			if (!Array.isArray(raw.entries)) return null;
			if (!allowStale && Date.now() - raw.timestamp >= CACHE_TTL_MS) return null;
			return raw.entries;
		} catch {
			return null;
		}
	}

	function writeCache(key: string, entries: MarketEntry[]): void {
		try {
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(
				join(cacheDir, `${key}.json`),
				JSON.stringify({ timestamp: Date.now(), entries } satisfies CacheEnvelope),
			);
		} catch {
			/* 缓存写不进去不影响这次结果 */
		}
	}

	async function getJson(url: string, source: McpMarketSource, timeoutMs = TIMEOUT_MS): Promise<unknown> {
		const response = await fetchImpl(url, {
			headers: {
				accept: "application/json",
				"user-agent": "oh-my-agent-web",
				// GitHub 未登录是 60 次/小时；有 token 就带上，避免共享 IP 撞限流
				...(source === "github" && githubToken() !== undefined ? { authorization: `Bearer ${githubToken()}` } : {}),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as unknown;
	}

	/** 注册中心：顺着 nextCursor 翻几页（没有 cursor 就停） */
	async function fetchRegistry(): Promise<MarketEntry[]> {
		const collected: MarketEntry[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < REGISTRY_PAGES; page += 1) {
			const url = new URL("https://registry.modelcontextprotocol.io/v0/servers");
			url.searchParams.set("limit", "100");
			if (cursor !== undefined) url.searchParams.set("cursor", cursor);
			const payload = await getJson(url.toString(), "registry");
			collected.push(...registryEntries(payload));
			const next = record(record(payload)?.metadata)?.nextCursor;
			if (typeof next !== "string" || next === "") break;
			cursor = next;
		}
		return collected;
	}

	async function fetchEntries(source: McpMarketSource, query: string): Promise<MarketEntry[]> {
		if (source === "registry") {
			// 带查询词就用它自己的 search：本地只有最近那 100 来条（注册中心按版本翻页，
			// 去重后没多少），`filesystem` 这种常见词在本地过滤里根本搜不到。
			// 代价是 40–50 秒，界面上会明说是「慢」，结果按查询词缓存一小时。
			if (query.trim() === "") return fetchRegistry();
			const url = new URL("https://registry.modelcontextprotocol.io/v0/servers");
			url.searchParams.set("search", query.trim());
			url.searchParams.set("limit", "50");
			return registryEntries(await getJson(url.toString(), "registry", SEARCH_TIMEOUT_MS));
		}
		if (source === "smithery") {
			const url = new URL("https://api.smithery.ai/servers");
			url.searchParams.set("pageSize", "50");
			if (query.trim() !== "") url.searchParams.set("q", query.trim());
			return smitheryEntries(await getJson(url.toString(), "smithery"));
		}
		return githubEntries(
			await getJson("https://api.github.com/repos/modelcontextprotocol/servers/contents/src", "github"),
		);
	}

	async function list(input: { source: McpMarketSource; query?: string; refresh?: boolean }): Promise<MarketResult> {
		const source = input.source;
		const query = input.query ?? "";
		const key = cacheKeyOf(source, query);
		if (input.refresh !== true) {
			const fresh = readCache(key, false);
			if (fresh) return { ok: true, source, entries: filterEntries(fresh, query), cached: true };
		}
		try {
			const entries = dedupeByName(await fetchEntries(source, query));
			if (entries.length === 0) throw new Error("这个源没有给出可用的服务器");
			// 注册中心 / GitHub 存全量（搜索靠本地过滤）；Smithery 与注册中心的搜索按查询词存
			writeCache(key, entries);
			return { ok: true, source, entries: filterEntries(entries, query) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stale = readCache(key, true);
			if (stale) {
				return {
					ok: true,
					source,
					entries: filterEntries(stale, query),
					cached: true,
					error: `拉取失败，显示的是上次的缓存：${message}`,
				};
			}
			return { ok: false, source, entries: [], error: message };
		}
	}

	return { list };
}
