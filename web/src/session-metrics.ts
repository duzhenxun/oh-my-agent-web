/** 会话相关的数字格式化（纯函数，前端多处共用）。 */

/**
 * 纯函数：token 数缩写成 K / M（尾注、状态栏、子代理卡片都用它，别各写一套）。
 * 千以内原样；一万以上不带小数（17.7K / 356K），百万以上两位（4.52M）。
 * 精确值不进正文 —— 要精度就看 title（拿鼠标悬上去）。
 */
export function compactTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}
