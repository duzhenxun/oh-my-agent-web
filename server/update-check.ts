/**
 * 「有没有新版」：启动时顺手看一眼（`aw upgrade` 的自动版）。
 *
 * 为什么要它：默认前台启动之后，用户很少再想起去 `aw status` / `aw upgrade`，
 * 于是装了旧版也不知道 —— 而 upgrade 是**手动**的，不提醒就永远不会发生。
 *
 * 四条纪律：
 *   1. **不挡启动**：整件事异步跑，网络失败 / 超时（1.5 秒）就当没这回事，绝不抛错；
 *   2. **不每次都问 npm**：结果按 24 小时缓存在 `<dataDir>/update-check.json`；
 *   3. **能关**：`AGENT_WEB_UPDATE_CHECK=off`（离线 / 内网 / CI）；
 *   4. **只报告，不替用户升级**：升级可能打断正在跑的回合，必须由人来按（`aw upgrade`）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageMeta } from "./util/version.js";

const CACHE_FILE = "update-check.json";
/** 缓存 24 小时：够新鲜，也不至于敲一次 `aw` 就问一次 npm */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

export type UpdateCheckResult = {
	current: string;
	latest: string;
	hasUpdate: boolean;
};

type CachedLatest = { checkedAt: number; latest: string };

/** `v1.2.3` / `1.2.3-rc.1` → 数字段 + 预发布标记 */
function parseVersion(value: string): { numbers: number[]; pre: string | null } {
	const cleaned = value.trim().replace(/^v/i, "");
	const dash = cleaned.indexOf("-");
	const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
	const pre = dash === -1 ? null : cleaned.slice(dash + 1);
	const numbers = core.split(".").map((part) => {
		const parsed = Number.parseInt(part, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	});
	return { numbers, pre };
}

/**
 * `candidate` 是否比 `current` 新（纯函数，好测）。
 *
 * 规则按 semver 够用的部分来：先比数字段（缺的位按 0 补），数字一样时
 * **正式版比预发布版新**（`1.0.0` > `1.0.0-rc.1`），两个都是预发布就按字符串比（`rc.2` > `rc.1`）。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	const now = parseVersion(current);
	const length = Math.max(next.numbers.length, now.numbers.length);
	for (let index = 0; index < length; index += 1) {
		const a = next.numbers[index] ?? 0;
		const b = now.numbers[index] ?? 0;
		if (a !== b) return a > b;
	}
	if (next.pre === now.pre) return false;
	if (next.pre === null) return true;
	if (now.pre === null) return false;
	return next.pre > now.pre;
}

function cachePath(dataDir: string): string {
	return join(dataDir, CACHE_FILE);
}

function readCache(dataDir: string): CachedLatest | null {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(dataDir), "utf8")) as Partial<CachedLatest>;
		if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return null;
		return { checkedAt: parsed.checkedAt, latest: parsed.latest };
	} catch {
		return null;
	}
}

function writeCache(dataDir: string, entry: CachedLatest): void {
	try {
		mkdirSync(dirname(cachePath(dataDir)), { recursive: true });
		writeFileSync(cachePath(dataDir), `${JSON.stringify(entry)}\n`);
	} catch {
		// 写不进去（只读目录 / 权限）不影响任何功能，下次再查就是了
	}
}

/** 问 npm registry 要 latest 版本号；拿不到就 null（网络不通是常态，不是错误） */
async function fetchLatestVersion(name: string): Promise<string | null> {
	const registry = (process.env.AGENT_WEB_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
	try {
		const response = await fetch(`${registry}/${name.replace("/", "%2F")}/latest`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			// 只要版本号，别把整个 manifest 拉下来
			headers: { accept: "application/vnd.npm.install-v1+json" },
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { version?: unknown };
		return typeof body.version === "string" ? body.version : null;
	} catch {
		return null;
	}
}

/**
 * 查一次「要不要升级」。返回值 `null` = 不用提示（关掉了 / 没发布 / 网络不通）。
 *
 * `now` 可注入，测试与「缓存过期」判断都靠它。
 */
export async function checkForUpdate(options: {
	dataDir: string;
	now?: () => number;
}): Promise<UpdateCheckResult | null> {
	const flag = process.env.AGENT_WEB_UPDATE_CHECK;
	if (flag === "off" || flag === "0" || flag === "false") return null;

	const meta = packageMeta();
	// private = 没发布到 npm（`aw upgrade` 也拒绝），版本 unknown = 连 package.json 都没读到
	if (meta.private || meta.version === "unknown") return null;

	const now = options.now?.() ?? Date.now();
	const cached = readCache(options.dataDir);
	let latest = cached && now - cached.checkedAt < CACHE_TTL_MS && cached.checkedAt <= now ? cached.latest : null;
	if (!latest) {
		const fetched = await fetchLatestVersion(meta.name);
		if (!fetched) return null; // 查不到就不提示，也不写缓存（下次启动再试）
		latest = fetched;
		writeCache(options.dataDir, { checkedAt: now, latest });
	}

	return { current: meta.version, latest, hasUpdate: isNewerVersion(latest, meta.version) };
}

/** 一行给人看的提示；`null` = 不用说话 */
export function describeUpdate(result: UpdateCheckResult | null): string | null {
	if (!result?.hasUpdate) return null;
	return `有新版本 v${result.latest}（当前 v${result.current}）→ 升级：aw upgrade`;
}
