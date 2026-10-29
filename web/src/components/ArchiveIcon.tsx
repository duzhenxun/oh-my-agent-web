/**
 * 「归档」图标：盒子 + 盒盖 + 一道横槽（就是常见的 archive 图形，用户指定的那种）。
 *
 * 之前这里是 🗄 emoji —— 彩色字体图标，跟这一排细描边按钮不是一个语汇；
 * 项目里其它图标都是 24 格 / 1.8 描边的线条，这里统一成同一套。
 */
const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

export function ArchiveIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			{/* 盒盖 */}
			<rect x="3.2" y="3.8" width="17.6" height="4.8" rx="1.4" {...STROKE} />
			{/* 盒体（从盒盖下面垂下来） */}
			<path d="M4.9 8.6v9.6a1.8 1.8 0 0 0 1.8 1.8h10.6a1.8 1.8 0 0 0 1.8-1.8V8.6" {...STROKE} />
			{/* 中间的横槽 */}
			<path d="M9.4 13.2h5.2" {...STROKE} />
		</svg>
	);
}
