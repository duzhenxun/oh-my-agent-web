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
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 260;

export const SIDEBAR_WIDTH_KEY = "agent-web.sidebar.width";
export const SIDEBAR_COLLAPSED_KEY = "agent-web.sidebar.collapsed";

/**
 * 窄窗下侧栏的**实际宽度上限**：窗口减去「右边必须留出来的量」。
 *
 * 为什么需要它：`SIDEBAR_MAX_WIDTH` 只管「拖多宽」，跟窗口无关 —— 在 560px 的窗口里
 * 照样能把侧栏拖到 516px。窗口窄的时候，右边的会话标题 + 那排入口不能只剩图标
 * 或只剩标题（用户报的「才这么宽，顶部标题就不显示了」），所以侧栏得让位。
 *
 * 谁先让位：**侧栏先让**。右边的会话标题 + 那排入口是「现在在跟谁聊 / 能开哪个面板」，
 * 窗口窄的时候不能只剩图标或只剩标题 —— 而侧栏里的会话名截短一点仍然可用。
 * 430px = 入口排（只留图标约 230px）+ 会话标题（约 180px）+ 两处间距。
 *
 * CSS 侧同一个数在 `styles/responsive.css`（`.side-host` 的 `max-width`，同区间）。
 * （顶栏左段已改成按内容定宽、与侧栏解耦，不再需要用同一个数夹。）
 */
const SIDEBAR_NARROW_RESERVE = 430;
/** 这条「预留」规则生效到多宽为止（更宽的窗口按 `SIDEBAR_MAX_WIDTH` 走，与 media 区间同一对数） */
const SIDEBAR_NARROW_MAX_VIEWPORT = 1000;

/** 纯函数：把宽度夹到合法区间（并取整，避免拖出半像素导致抖动） */
export function clampSidebarWidth(width: number, max = SIDEBAR_MAX_WIDTH): number {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), Math.max(SIDEBAR_MIN_WIDTH, max)));
}

/**
 * 纯函数：某个窗口宽度下，侧栏**实际能占**多宽（拖动时也按它夹，免得存进去一个永远显示不出来的值）。
 *
 * - 宽窗（> 1000px）→ `SIDEBAR_MAX_WIDTH`（CSS 那条预留规则不生效）；
 * - 窄窗 → `窗口宽 - 430px`，但不低于 `SIDEBAR_MIN_WIDTH`（否则侧栏窄到没法认）。
 *
 * 与 `styles/responsive.css` 的 `@media (min-width: 401px) and (max-width: 1000px)` 是同一份意图；
 * CSS 侧同一个数在 `styles/responsive.css`（`max(240px, calc(100vw - 430px))`）—— 改一边必须改另一边，
 * 否则两处宽度不一致，顶栏那道分段线就会跟侧栏边框错开。
 */
export function sidebarMaxWidth(viewport: number): number {
	if (!Number.isFinite(viewport) || viewport <= 0) return SIDEBAR_MAX_WIDTH;
	if (viewport > SIDEBAR_NARROW_MAX_VIEWPORT) return SIDEBAR_MAX_WIDTH;
	return Math.max(SIDEBAR_MIN_WIDTH, Math.round(viewport - SIDEBAR_NARROW_RESERVE));
}

export function readStoredWidth(raw: string | null): number {
	if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
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
