/**
 * 贴着触发器「正上方」的浮层坐标（纯函数）。
 *
 * 为什么要有这一层：状态栏是 `overflow: hidden` 的容器，浮层只能 `position: fixed` +
 * 现算坐标。以前两处各写一遍，而且都按「**右边缘**对齐触发器右边缘」算 ——
 * 于是点在胶囊中间时，浮层往左支出一大截，看着像「没对准我点的地方」。
 * 统一成「**水平中心对齐触发器中心**」，再夹到视口内（窄屏贴边不回弹出屏幕）。
 */
type AnchorBox = { left: number; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/** 视口左右各留的安全边距 */
const VIEWPORT_PAD = 8;
/** 小尾巴离浮层左右圆角的最小距离（太靠边会插进圆角外） */
const ARROW_PAD = 14;

/**
 * 算出浮层的 `left`、`bottom` 与小尾巴的 `arrow`。
 * 用 bottom 是为了「贴着一条固定在底部的状态栏往上长」，浮层高度变化时不会突然跳；
 * `arrow` 是尾巴**中心**相对浮层左边缘的偏移（直接喂给 `style.left`，再配 `margin-left: -半宽`）。
 */
export function centeredPopoverAnchor(input: {
	/** 触发器（胶囊按钮）的盒 */
	trigger: AnchorBox;
	/** 浮层自己的盒（只需要 width） */
	popover: { width: number };
	viewport: Viewport;
	/** 与触发器之间的缝 */
	gap?: number;
}): { left: number; bottom: number; arrow: number } {
	const gap = input.gap ?? 8;
	const centered = input.trigger.left + input.trigger.width / 2 - input.popover.width / 2;
	// 右边的上限不能小于左边的最小值：浮层比视口还宽时，宁可贴左也不要把 left 算成负数
	const maxLeft = Math.max(VIEWPORT_PAD, input.viewport.width - input.popover.width - VIEWPORT_PAD);
	const left = Math.min(Math.max(VIEWPORT_PAD, centered), maxLeft);
	// 小尾巴始终指着**触发器中心**：浮层被夹到视口边缘时，左边缘挪了而触发器没动，
	// 所以这里按「触发器中心 - 浮层左边缘」现算，而不是跟着浮层一起居中。
	const triggerCenter = input.trigger.left + input.trigger.width / 2;
	const maxArrow = Math.max(ARROW_PAD, input.popover.width - ARROW_PAD);
	const arrow = Math.min(Math.max(ARROW_PAD, triggerCenter - left), maxArrow);
	return {
		left,
		bottom: input.viewport.height - input.trigger.top + gap,
		arrow,
	};
}

/**
 * 浮层在触发器**下方**时的坐标（顶栏徽标的浮层用它）。
 *
 * 与 `centeredPopoverAnchor` 同一套纪律，只是方向相反：那条是"贴着底部状态栏往上长"，这条是
 * "从顶栏往下掉"。两者都**水平居中于触发器**并夹进视口 ——
 * 以前这套浮层是 `right: 0` 贴触发器右边缘：桌面看着还行，手机上（宽 351px 的卡片挂在靠右的
 * 徽标上）左边直接溢出屏幕，看起来就是"跑偏了、被挡掉一半"。
 */
export function belowPopoverAnchor(input: {
	trigger: AnchorBox;
	/** 浮层宽度（高度由 CSS 的 max-height 管，这里不参与计算） */
	popover: { width: number };
	viewport: Viewport;
	/** 与触发器之间的缝 */
	gap?: number;
}): { left: number; top: number; arrow: number } {
	const gap = input.gap ?? 6;
	const centered = input.trigger.left + input.trigger.width / 2 - input.popover.width / 2;
	const maxLeft = Math.max(VIEWPORT_PAD, input.viewport.width - input.popover.width - VIEWPORT_PAD);
	const left = Math.min(Math.max(VIEWPORT_PAD, centered), maxLeft);
	const triggerCenter = input.trigger.left + input.trigger.width / 2;
	const maxArrow = Math.max(ARROW_PAD, input.popover.width - ARROW_PAD);
	return {
		left,
		top: input.trigger.top + input.trigger.height + gap,
		// 小尾巴（朝上）始终指着触发器中心，浮层被夹到边缘时也不会漂
		arrow: Math.min(Math.max(ARROW_PAD, triggerCenter - left), maxArrow),
	};
}
