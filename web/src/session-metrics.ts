/**
 * 会话信息里的两个派生指标（纯函数，便于单测）：
 *   - 活跃时长：从会话创建到最后一次更新的跨度（wall clock，含空闲）
 *   - 缓存命中率：缓存读取 / (输入 + 缓存读取)
 */

/** 纯函数：把毫秒格式化成「3h 12m」这种紧凑形式 */
export function formatSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) return "<1m";
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** 纯函数：缓存命中率（0–1）；分母为 0 时返回 null（显示「—」而不是 0%） */
export function cacheHitRate(inputTokens: number, cacheRead: number): number | null {
	const total = inputTokens + cacheRead;
	if (total <= 0) return null;
	return cacheRead / total;
}

/** 纯函数：把 0–1 的比例格式化成一位小数的百分比 */
export function formatPercent(ratio: number | null): string {
	if (ratio === null) return "—";
	return `${(ratio * 100).toFixed(1)}%`;
}
