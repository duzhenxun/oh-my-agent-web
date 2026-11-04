/**
 * 侧栏的尺寸与收纳（纯函数）：
 *   - 宽度可拖拽调整，但必须夹在 [MIN, MAX] 之间（太窄看不清、太宽吃掉对话区）；
 *   - 收纳状态与宽度都存 localStorage，刷新后保持。
 */
/**
 * 侧栏最小宽度：**240px**（原先 180px）。
 *
 * 为什么抬到 240（用户 2026-10-29：「左侧这边，设置一下他最小宽度，不能小于这个值」）：
 * 180px 时项目行根本放不下「文件夹图标 + 项目名 + 运行中/圆点 + ⋯」，会话标题也只剩
 * 两三个字 —— 顶上那颗「运行中」角标会直接压在标题文字上，看着像排版坏了。
 * 240px 是「项目名 + 角标」能完整排开、会话标题还剩得下一行的下限；再窄就只能拖回收起态。
 *
 * CSS 侧同一个数在 `styles/responsive.css`（`max(240px, calc(100vw - 430px))`）—— 改一边必须改另一边。
 */
export const SIDEBAR_MIN_WIDTH = 240;
/**
 * 侧栏最宽能到多少：**只留住右边那 240px**（用户 2026-11-04：「最大宽度可以不限制」）。
 *
 * 以前硬顶 520px，宽屏上想并排看两栏内容（长路径的文件树 + 宽 diff）就顶住了。
 * 现在上限跟着窗口走：`窗口宽 - 240`。留这 240px 不是为了好看，是两条硬需求：
 *   1. 对话区不能被彻底压没 —— 压到 0 就再也点不回输入框了；
 *   2. 那条拖拽把手画在侧栏**右外侧**（`right: -8px`），侧栏铺满窗口时它就出屏了，
 *      再也没法把侧栏拖回来。
 */
export const SIDEBAR_CHAT_RESERVE = 240;
const SIDEBAR_DEFAULT_WIDTH = 260;

export const SIDEBAR_WIDTH_KEY = "agent-web.sidebar.width";
export const SIDEBAR_COLLAPSED_KEY = "agent-web.sidebar.collapsed";

/** 纯函数：把宽度夹到合法区间（并取整，避免拖出半像素导致抖动）。`max` 默认「不设上限」 */
export function clampSidebarWidth(width: number, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), Math.max(SIDEBAR_MIN_WIDTH, max)));
}

/**
 * 纯函数：某个窗口宽度下，侧栏**实际能占**多宽（拖动时也按它夹，免得存进去一个显示不出来的值）。
 *
 * **不再有固定的 520 上限**（用户 2026-11-04）：只保留右边那 `SIDEBAR_CHAT_RESERVE`
 * （240px）给对话区与那条拖拽把手 —— 见那个常量的注释。宽屏 / 窄屏同一条公式，
 * 所以「窗口越小侧栏越窄」这件事天然成立，另外那条 `- 430px` 的窄窗规则不需要了。
 *
 * CSS 侧同一个数在 `styles/responsive.css`（`.side-host` 的 `max-width`，401~1000px 区间）——
 * 改一边必须改另一边，否则「拖到一半不动了」。
 */
export function sidebarMaxWidth(viewport: number): number {
	// 拿不到窗口宽度（首帧 / 坏值）：不设上限，下限交给 clampSidebarWidth 保底
	if (!Number.isFinite(viewport) || viewport <= 0) return Number.MAX_SAFE_INTEGER;
	return Math.max(SIDEBAR_MIN_WIDTH, Math.round(viewport - SIDEBAR_CHAT_RESERVE));
}

export function readStoredWidth(raw: string | null): number {
	if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
	// 存下来的值不再被 520 截断（用户可能已经把侧栏拖到很宽）：真正显示时的上限由
	// `sidebarMaxWidth(窗口宽)` + CSS 那条 media 规则一起管
	return clampSidebarWidth(Number(raw));
}

/**
 * 纯函数：侧栏默认是否收起。
 *
 * - 用户手动开合过（localStorage 有记录）→ 尊重记录（"1" 收起 / "0" 展开）；
 * - 没记录时按设备决定：**平板**（触摸屏且宽度 > 600）默认收起 —— 平板屏幕够大，
 *   一进页面先看对话更合理，要切会话再点 ☰；单栏（≤400）的手机仍旧展开（一进来就是要挑会话）。
 */
export function defaultCollapsed(input: { stored: string | null; tablet: boolean }): boolean {
	if (input.stored === "1") return true;
	if (input.stored === "0") return false;
	return input.tablet;
}

/** 平板判定：触摸 + 宽度 601~1366（平板现在也是双栏，只是默认把侧栏收起来更舒服） */
export function isTablet(query: (text: string) => boolean): boolean {
	return query("(pointer: coarse) and (min-width: 601px) and (max-width: 1366px)");
}
