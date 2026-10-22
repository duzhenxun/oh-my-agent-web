/**
 * 上游（GitHub）最新版本号：新会话抬头的 `web v0.1.0` 靠它决定「要不要标红提醒有新版」。
 *
 * 为什么是查上游而不是读本地两份 package.json：抬头那行是在说「我在跑哪个版本」，
 * 只有跟**已发布的版本**比，才知道「该不该提醒你去更新」。
 *
 * 三条纪律：
 *   - **绝不抛、绝不阻塞**：离线 / 超时 / 被墙 / 上游文件写坏都只是 `null` = 不知道有没有新版，
 *     界面照旧显示版本号、不标红、不弹提示条。启动不能因为一次网络请求慢半拍。
 *   - **只在服务端查**：浏览器直连 raw.githubusercontent 要看 CORS 与代理脸色；
 *     而且「上游是什么」本来就该是服务端作为唯一事实源给出的（ADR-0012）。
 *   - **一个进程内低频查**：成功缓存 6 小时、失败缓存 10 分钟（慢网不至于被重试拖死），
 *     再配合定时器轮询 —— 服务器开着好几天也能在下次轮询时看到新版本。
 */

/** 仓库地址：抬头那行版本号点它跳过去（前端也 import 这份常量，避免两处各写一遍） */
export const REPO_URL = "https://github.com/duzhenxun/oh-my-agent-web";
/** 拿版本号的分支：跟 `main` 上的 package.json 对齐（发版就是改那里） */
export const REPO_BRANCH = "main";
/** 只要一个版本号，不必走 GitHub API（匿名 API 有速率限制，raw 没有） */
export const VERSION_URL = `https://raw.githubusercontent.com/duzhenxun/oh-my-agent-web/${REPO_BRANCH}/package.json`;

/** 一次请求最多等这么久：等不到就当没网 */
export const FETCH_TIMEOUT_MS = 4000;
/** 成功结果的保鲜期：6 小时（发版是低频事件，没必要频繁打人家的 CDN） */
export const OK_TTL_MS = 6 * 60 * 60 * 1000;
/** 失败结果的保鲜期：10 分钟（断网时别每帧都去试） */
export const FAIL_TTL_MS = 10 * 60 * 1000;

export type FetchLike = (
	url: string,
	init: { signal: AbortSignal },
) => Promise<{
	ok: boolean;
	text(): Promise<string>;
}>;

/**
 * 从 package.json 文本里抠 `"version"`。
 *
 * 不 `JSON.parse`：上游文件里我们只要这一个字段，别的字段写坏（注释、尾逗号）不该连版本号一起丢。
 */
export function parseVersion(text: string): string | null {
	const matched = /"version"\s*:\s*"([^"]+)"/.exec(text);
	const version = matched?.[1]?.trim();
	return version ? version : null;
}

/** 版本号切成数字段：`v1.2.3` → `[1,2,3]`；`1.2.3-beta.1` 的预发布后缀忽略（比大小只看前三段） */
function versionParts(version: string): number[] {
	return version
		.replace(/^v/i, "")
		.split("-")[0]
		.split(".")
		.map((item) => {
			const parsed = Number.parseInt(item, 10);
			return Number.isFinite(parsed) ? parsed : 0;
		});
}

/** 比大小：`a` 新于 `b` 返回正数，相等 0，更旧负数（缺的段按 0 算，所以 `1.0` == `1.0.0`） */
export function compareVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * 上游比本机新吗（= 该提醒更新了）。
 *
 * 本机反而更新（本地改了版本号还没发版）**不算** —— 那时候标红会误导人跑去「更新」，
 * 而他要的其实是「发布」。
 */
export function isOutdated(latest: string | null, current: string): boolean {
	if (!latest) return false;
	if (current === "" || current === "unknown") return false; // 读不到本机版本时不给结论
	return compareVersions(latest, current) > 0;
}

/** 真去拉一次（不带缓存）：任何异常都咽掉，返回 null */
export async function fetchLatestVersion(
	options: {
		fetchImpl?: FetchLike;
		url?: string;
		timeoutMs?: number;
	} = {},
): Promise<string | null> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
	if (!fetchImpl) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
	timer.unref?.();
	try {
		const response = await fetchImpl(options.url ?? VERSION_URL, { signal: controller.signal });
		if (!response.ok) return null;
		return parseVersion(await response.text());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

type CacheEntry = { value: string | null; at: number };

/**
 * 带缓存的上游版本查询：同一个进程里多处调用只算一次网络（在飞时合并成同一个 promise）。
 *
 * 缓存是模块级的：启动流程、回调、定时器都可能问它，各自持有一份缓存就会各打一次网络。
 */
let cache: CacheEntry | null = null;
let inflight: Promise<string | null> | null = null;

export async function checkUpstreamVersion(
	options: {
		fetchImpl?: FetchLike;
		url?: string;
		timeoutMs?: number;
		now?: () => number;
	} = {},
): Promise<string | null> {
	const now = options.now ?? (() => Date.now());
	const ttl = cache?.value ? OK_TTL_MS : FAIL_TTL_MS;
	if (cache && now() - cache.at < ttl) return cache.value;
	if (inflight) return inflight;
	inflight = fetchLatestVersion(options)
		.then((value) => {
			cache = { value, at: now() };
			return value;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/**
 * 起一个「盯着上游版本」的定时器：先立刻查一次，之后每隔 `intervalMs` 再查（缓存过期的才会真发请求）。
 *
 * 回调只在**拿到的值和上一次不同**（且不是 null）时触发 —— 界面照这个值刷一帧就够，
 * 不必每 6 小时白推一帧一模一样的快照。返回停止函数（测试 / 收摊用）。
 *
 * 轮询间隔取**短的**那个 TTL（10 分钟）：多数情况下缓存还没过期，醒一下不花一个字节；
 * 而启动时那次网络万一赶上断网，10 分钟后就能自愈，不用等满 6 小时。
 */
export function startUpstreamVersionWatch(
	onChange: (latest: string) => void,
	options: {
		fetchImpl?: FetchLike;
		url?: string;
		timeoutMs?: number;
		intervalMs?: number;
		now?: () => number;
	} = {},
): () => void {
	let last: string | null = null;
	const tick = (): void => {
		void checkUpstreamVersion(options).then((latest) => {
			if (!latest || latest === last) return;
			last = latest;
			onChange(latest);
		});
	};
	tick();
	const timer = setInterval(tick, options.intervalMs ?? FAIL_TTL_MS);
	timer.unref?.(); // 别拦着进程退出
	return () => clearInterval(timer);
}
