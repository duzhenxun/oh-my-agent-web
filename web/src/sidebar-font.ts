/**
 * 侧栏里两处文字的字号：**项目名**和**会话名**（设置 → 外观）。
 *
 * 与聊天字号（`chat-display.ts`）同一套做法：纯本机偏好、`localStorage`、`agent-web.` 前缀、
 * **首帧前就生效**（写到 `<html>` 的两个 CSS 变量上），不进快照、不上云。
 *
 * 为什么分两个开关而不是一个：侧栏是「分组标题 + 一长串会话」两层信息。
 * 想一眼扫更多项目的人会把项目名收小；会话标题往往要读内容，就留大一点 ——
 * 反过来也一样合理，所以两条各管各的。
 *
 * 生效方式（都在 sidebar.css / session-row.css 里消费）：
 *   --side-project-font-size   项目行（`.proj-head`）的字号，占位行文字也跟着它
 *   --side-session-font-size   会话行（`.pi-row`）的字号；标题继承它，
 *                              时间 / 项目名 / 「运行中」这些次要文字用 em 按比例缩
 */
import { DEFAULT_FONT_PX, clampFontPx, fontPxCss, readStoredFontPx, upgradeStoredFontPx } from "./font-scale.ts";

/**
 * 存储 key 带 `.v2`：字号刻度 2026-10-29 整体上移（「标准」12/13 → 14），
 * 老 key 里存的是**旧刻度的绝对像素**，新代码直接读会留在 12px（还是发扁）。
 * 所以换成新 key，首次读到时把老值平移 +2px 写过来（见 `upgradeStoredFontPx`），
 * 之后老 key 就不再看 —— 迁移只发生一次。
 */
const SIDEBAR_PROJECT_FONT_KEY = "agent-web.sidebar-project-font.v2";
const SIDEBAR_PROJECT_FONT_LEGACY_KEY = "agent-web.sidebar-project-font";
const SIDEBAR_SESSION_FONT_KEY = "agent-web.sidebar-session-font.v2";
const SIDEBAR_SESSION_FONT_LEGACY_KEY = "agent-web.sidebar-session-font";

/** 变更事件：`<html>` 的变量变了但 React 不知道，用它通知设置面板里的选中态 */
const SIDEBAR_FONT_EVENT = "agent-web:sidebar-font";

/** 两处字号（**像素**，滑杆给的值；区间与步长见 `font-scale.ts`） */
export type SidebarFontState = { project: number; session: number };

function readKey(key: string, legacyKey: string, layer: "project" | "session"): number {
	if (typeof localStorage === "undefined") return DEFAULT_FONT_PX[layer];
	try {
		const raw = localStorage.getItem(key);
		if (raw !== null && raw !== "") return readStoredFontPx(raw, layer);
		// 老 key：迁移一次到新刻度（+2px），写完就用新 key
		const legacy = localStorage.getItem(legacyKey);
		if (legacy !== null && legacy !== "") {
			const upgraded = upgradeStoredFontPx(legacy, layer);
			localStorage.setItem(key, String(upgraded));
			return upgraded;
		}
		return DEFAULT_FONT_PX[layer]; // 从未调过：用新默认值 14px
	} catch {
		return DEFAULT_FONT_PX[layer]; // 隐私模式禁 localStorage：用默认值，不抛错
	}
}

function currentSidebarProjectFont(): number {
	return readKey(SIDEBAR_PROJECT_FONT_KEY, SIDEBAR_PROJECT_FONT_LEGACY_KEY, "project");
}

function currentSidebarSessionFont(): number {
	return readKey(SIDEBAR_SESSION_FONT_KEY, SIDEBAR_SESSION_FONT_LEGACY_KEY, "session");
}

export function currentSidebarFonts(): SidebarFontState {
	return { project: currentSidebarProjectFont(), session: currentSidebarSessionFont() };
}

/** 把两个变量写到 `<html>` 上并广播一次变更 */
function applySidebarFonts(state: SidebarFontState): void {
	const style = document.documentElement.style;
	style.setProperty("--side-project-font-size", fontPxCss(state.project));
	style.setProperty("--side-session-font-size", fontPxCss(state.session));
	window.dispatchEvent(new CustomEvent<SidebarFontState>(SIDEBAR_FONT_EVENT, { detail: state }));
}

/** 首帧前调用（`main.tsx`）：读存储并应用 */
export function initSidebarFonts(): void {
	applySidebarFonts(currentSidebarFonts());
}

function persist(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 存不下就只在本页生效（与主题 / 聊天字号同一处理）
	}
}

export function setSidebarProjectFont(px: number): void {
	const value = clampFontPx(px, "project");
	persist(SIDEBAR_PROJECT_FONT_KEY, String(value));
	applySidebarFonts({ project: value, session: currentSidebarSessionFont() });
}

export function setSidebarSessionFont(px: number): void {
	const value = clampFontPx(px, "session");
	persist(SIDEBAR_SESSION_FONT_KEY, String(value));
	applySidebarFonts({ project: currentSidebarProjectFont(), session: value });
}

/** 订阅变更（含其它标签页改同一项时的 `storage` 事件） */
export function onSidebarFontChange(callback: (state: SidebarFontState) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<SidebarFontState>).detail;
		if (detail) callback(detail);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== SIDEBAR_PROJECT_FONT_KEY && event.key !== SIDEBAR_SESSION_FONT_KEY) return;		const next = currentSidebarFonts();
		applySidebarFonts(next);
		callback(next);
	};
	window.addEventListener(SIDEBAR_FONT_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(SIDEBAR_FONT_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}
