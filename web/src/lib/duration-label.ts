/**
 * 「耗时」怎么写成一行字（对话里那条 `耗时 1m20s` 的尾注 / 过程折叠头共用）。
 *
 * 档位：`840ms` → `1.4s` → `32s` → `1m20s` → `2h03m`
 *
 * 为什么单独一个纯函数：这行字出现在两处（折叠头、消息尾注），而"到多少换档"是用户三番
 * 五次调过的——写成 `Number` 进 `String` 出，能直接单测，不用为了验证一个档位去拉整个组件。
 *
 * 超过 60 分钟**必须换成小时**（用户 2026-11-02：「耗时 123m3s，超过 60 分钟要显示小时哦」）：
 * `123m3s` 得自己在脑子里除 60，看不出"这一轮跑了两个多小时"。小时档跟子代理那套
 * （`subagent-view.tsx` 的 `duration` / `durationMs`）同一个写法：`2h03m`，分钟补零对齐。
 * 到小时这一档就不再给秒了 —— 两个多小时的一轮，秒是个噪音。
 */
export function formatDuration(ms: number): string {
	// 负数 / NaN 一律当 0：时钟回拨、缺时间戳、老历史里算出来是负的都有可能，
	// 宁可显示 0ms，也别画出「-5000ms」或「NaNm」这种怪字
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	if (safe < 1000) return `${Math.round(safe)}ms`;
	if (safe < 60_000) return safe < 10_000 ? `${(safe / 1000).toFixed(1)}s` : `${Math.round(safe / 1000)}s`;
	const minutes = Math.floor(safe / 60_000);
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	}
	const seconds = Math.round((safe % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/**
 * 「正在跑多久」那种**走秒**的行用：平时给整秒（`1s` / `42s`，每秒跳一格），
 * 过了 1 小时换成 `2h03m` ——
 * 跟 `formatDuration` 分开的理由：走秒行不能给小数（`4.2s` 每秒都在抖），
 * 但两小时的工具行写成 `7203s` 跟「耗时 123m3s」是同一个毛病（用户 2026-11-02）。
 */
export function formatElapsedSeconds(seconds: number): string {
	const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	return safe < 3600 ? `${safe}s` : formatDuration(safe * 1000);
}
