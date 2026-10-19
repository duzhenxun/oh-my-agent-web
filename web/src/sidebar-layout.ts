/**
 * 侧栏的尺寸与收纳（纯函数，便于单测）：
 *   - 宽度可拖拽调整，但必须夹在 [MIN, MAX] 之间（太窄看不清、太宽吃掉对话区）；
 *   - 收纳状态与宽度都存 localStorage，刷新后保持。
 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 260;

export const SIDEBAR_WIDTH_KEY = "agent-web.sidebar.width";
export const SIDEBAR_COLLAPSED_KEY = "agent-web.sidebar.collapsed";

/** 纯函数：把宽度夹到合法区间（并取整，避免拖出半像素导致抖动） */
export function clampSidebarWidth(width: number, max = SIDEBAR_MAX_WIDTH): number {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), Math.max(SIDEBAR_MIN_WIDTH, max)));
}

/** 纯函数：从 localStorage 读宽度（坏值回默认） */
export function readStoredWidth(raw: string | null): number {
	if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
	return clampSidebarWidth(Number(raw));
}
