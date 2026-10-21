/**
 * 「手机壳」判定（与 CSS 里的断点、媒体查询保持一致）。
 *
 * 窄屏（≤900px）算手机壳 —— 三栏挤不下；
 * **触摸设备（pointer: coarse）也算**，即使宽度到 iPad 横屏的 1024/1180：
 * iPad 上三栏 + 悬浮侧栏体验很差，抽屉式更适合手指。
 * 上限 1366px 是为了不把触摸屏笔记本（>1366）也当成手机。
 */
export const MOBILE_SHELL_QUERY = "(max-width: 900px), (pointer: coarse) and (max-width: 1366px)";
