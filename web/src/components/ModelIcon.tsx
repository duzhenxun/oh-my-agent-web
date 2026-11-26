/**
 * 模型标识：**一圈 + 一个实心圆心**（"核心"的语汇）。
 *
 * 为什么换掉原来那枚「三层堆叠」：它的视觉重心压在 viewBox 上半
 * （顶上一个菱形 + 下面两道横线），跟旁边的文字放一起总觉得偏高，靠 `translateY(1px)` 硬补也只有
 * 4x 放大才对得上（用户 2026-11-23：「要是图标放了不跟文案对齐就换 2 个图标」）。
 * 现在这个图形**上下左右都对称**，光学中心就是几何中心，任何字号下都不会偏。
 */
export function ModelIcon() {
	return (
		<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.4" />
			<circle cx="8" cy="8" r="1.9" fill="currentColor" />
		</svg>
	);
}
