/**
 * 把**可视化视口**（visualViewport）的高度与纵向偏移同步到 CSS 变量 `--vvh` / `--vvtop`。
 *
 * 为什么需要：手机上一聚焦输入框就弹键盘，而 `100vh` / `100dvh` 量的是**布局视口**，
 * 键盘弹起时它不变 —— 于是「贴顶对齐 + 最大 80vh」的弹窗会被键盘从下面盖掉一截：
 * 「编辑快捷指令」里就是**看不到、也点不到「保存」**（只能盲滚，用户 2026-11-04 报的）。
 * `visualViewport` 给的才是当前真正能看见的那块高度，用它算弹窗上限就不会被盖住。
 *
 * 只在手机上真正有价值（桌面没有软键盘），但这里不判断 —— 由 CSS 决定怎么用：
 * 桌面那些 `max-height: 80vh` 的规则不引用这两个变量，写了也不影响。
 */
export function watchVisualViewport(): () => void {
	if (typeof window === "undefined" || !window.visualViewport) return () => {};
	const root = document.documentElement;
	const viewport = window.visualViewport;
	const sync = () => {
		// 取整：小数会让元素高度出现 0.5px 的抖动，滚动时看着像在颤
		root.style.setProperty("--vvh", `${Math.round(viewport.height)}px`);
		root.style.setProperty("--vvtop", `${Math.round(viewport.offsetTop)}px`);
	};
	sync();
	// resize：键盘弹出/收起、横竖屏；scroll：iOS 在聚焦时会把整个视口往上推（offsetTop 变）
	viewport.addEventListener("resize", sync);
	viewport.addEventListener("scroll", sync);
	return () => {
		viewport.removeEventListener("resize", sync);
		viewport.removeEventListener("scroll", sync);
	};
}
