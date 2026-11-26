/**
 * 思考强度标识：**三个越来越大的点**（低 / 中 / 高）。
 *
 * 换掉原来的 `⚡` emoji：Apple Color Emoji 里那个闪电又高又靠上，跟旁边的"高"字一起看永远像偏了
 * （用户 2026-11-23：「要是图标放了不跟文案对齐就换 2 个图标」）。
 * 三个点排在同一水平中心线上 → 图形本身就是对称的，不存在"光学重心偏移"。
 */
export function ThinkingIcon() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<circle cx="3.6" cy="8" r="1.5" />
			<circle cx="8" cy="8" r="2.1" />
			<circle cx="12.6" cy="8" r="2.7" />
		</svg>
	);
}
