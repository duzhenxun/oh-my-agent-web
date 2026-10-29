/**
 * 聊天区的两档显示偏好：**正文字号**和**内容宽度**（设置 → 外观）。
 *
 * 与主题（`theme.ts`）同一套纪律：纯本机偏好、`localStorage`、`agent-web.` 前缀、
 * **首帧前就生效**（写到 `<html>` 的两个 CSS 变量上），不进快照、不上云。
 *
 * 为什么不做成 `set_settings`（服务端偏好）：换个字号要等服务端往返一圈才生效，
 * 而且「这台设备的屏有多大、我眼睛累不累」本来就该各设备自己说了算 —— 和主题同一个理由。
 *
 * 生效方式：
 *   --chat-font-size   对话字号的基准：正文（`.md`）直接使用，排队 / 插队、工具卡、
 *                      尾注等聊天相关 UI 通过 `--chat-ui-font-size` 按比例联动
 *   --chat-max-width   对话列的宽带上限（`none` = 满宽）
 */
import { DEFAULT_FONT_PX, clampFontPx, fontPxCss, readStoredFontPx, upgradeStoredFontPx } from "./font-scale.ts";

export type ChatWidthId = "narrow" | "normal" | "wide" | "full";

type ChatWidthDef = { id: ChatWidthId; label: string; labelEn: string; /** 0 = 满宽（不限制） */ px: number };

/**
 * 宽度：默认 `full` = 不限制（原先就是铺满对话区）。
 * 窄/标准/宽只是给「一行太长读着累」的人一个上限，列会居中。
 */
export const CHAT_WIDTHS: readonly ChatWidthDef[] = [
	{ id: "narrow", label: "窄", labelEn: "Narrow", px: 720 },
	{ id: "normal", label: "标准", labelEn: "Default", px: 900 },
	{ id: "wide", label: "宽", labelEn: "Wide", px: 1100 },
	{ id: "full", label: "满宽", labelEn: "Full width", px: 0 },
];

const CHAT_FONT_KEY = "agent-web.chat-font.v2";
/**
 * 老 key：字号刻度 2026-10-29 整体上移（「标准」12 → 14），而滑杆存的是**绝对像素**。
 * 直接读老值会留在 12px（还是发扁），所以换新 key，首次读到时把老值平移 +2px
 * 写过来（见 `upgradeStoredFontPx`）—— 迁移只发生一次，之后老 key 不再看。
 */
const CHAT_FONT_LEGACY_KEY = "agent-web.chat-font";
const CHAT_WIDTH_KEY = "agent-web.chat-width";

/** 变更事件：`<html>` 的变量变了但 React 不知道，用它通知设置面板里的选中态 */
const CHAT_DISPLAY_EVENT = "agent-web:chat-display";

function findChatWidth(id: string | null | undefined): ChatWidthDef | null {
	return CHAT_WIDTHS.find((item) => item.id === id) ?? null;
}

/** 纯函数：坏值 / 老档位 / 没存过 → 像素字号（默认 14px，且会对到偶数） */
function readStoredFont(raw: string | null): number {
	return readStoredFontPx(raw, "chat");
}

/**
 * 读一个带迁移的字号 key：新 key 有值就用；否则把老 key 的值平移 +2px 写进新 key。
 * 两个都没 → 新默认值 14px（从没调过字号的人走这条）。
 */
function readFontWithLegacy(fallback: number): number {
	if (typeof localStorage === "undefined") return fallback;
	try {
		const raw = localStorage.getItem(CHAT_FONT_KEY);
		if (raw !== null && raw !== "") return readStoredFont(raw);
		const legacy = localStorage.getItem(CHAT_FONT_LEGACY_KEY);
		if (legacy !== null && legacy !== "") {
			const upgraded = upgradeStoredFontPx(legacy, "chat");
			localStorage.setItem(CHAT_FONT_KEY, String(upgraded));
			return upgraded;
		}
		return fallback;
	} catch {
		return fallback; // 隐私模式禁 localStorage：用默认值，不抛错
	}
}

export function readStoredWidth(raw: string | null): ChatWidthId {
	return findChatWidth(raw)?.id ?? "full";
}

/** 纯函数：字号（像素）+ 宽度 id 对应的 CSS 变量取值（不碰 DOM） */
function cssVarsOf(fontPx: number, width: ChatWidthId): { size: string; maxWidth: string } {
	const size = fontPxCss(fontPx);
	const px = (findChatWidth(width) ?? CHAT_WIDTHS[3]!).px;
	// 满宽用 `100%` 而不是 `none`：布局那边要拿它做 `calc((100% - var(--chat-max-width)) / 2)`，
	// `none` 会让整条 calc 失效（虽然也能退化成原来的样子，但那是靠"声明被丢掉"实现的，太隐晦）
	return { size, maxWidth: px > 0 ? `${px}px` : "100%" };
}

export function currentChatFont(): number {
	return readFontWithLegacy(DEFAULT_FONT_PX.chat);
}

export function currentChatWidth(): ChatWidthId {
	const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CHAT_WIDTH_KEY);
	return readStoredWidth(raw);
}

/** 把两个变量写到 `<html>` 上并广播一次变更 */
function applyChatDisplay(font: number, width: ChatWidthId): void {
	const vars = cssVarsOf(font, width);
	const style = document.documentElement.style;
	style.setProperty("--chat-font-size", vars.size);
	style.setProperty("--chat-max-width", vars.maxWidth);
	/**
	 * 宽度档也挂到 `<html data-chat-width>` 上：**满宽**要额外把左边那截留白收窄。
	 *
	 * 光靠变量做不到 —— `--chat-max-width` 在满宽时是 100%，CSS 没法问"这个值是不是满的"。
	 * 而左留白有两截（`.workspace` 的 20px + 内容的 16px），限宽时被居中计算掩盖了，
	 * 满宽时却原样留着，看起来"明明铺满了，左边还空一条"。
	 */
	document.documentElement.dataset.chatWidth = width;
	window.dispatchEvent(new CustomEvent(CHAT_DISPLAY_EVENT, { detail: { font, width } }));
}

/** 首帧前调用（`main.tsx`）：读存储并应用 */
export function initChatDisplay(): void {
	applyChatDisplay(currentChatFont(), currentChatWidth());
}

function persist(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 隐私模式 / 存储被禁：只在本页生效，不报错（与主题同一处理）
	}
}

/** 改正文字号（像素；进来自动夹区间、对齐 0.5 步长） */
export function setChatFont(px: number): void {
	const value = clampFontPx(px, "chat");
	persist(CHAT_FONT_KEY, String(value));
	applyChatDisplay(value, currentChatWidth());
}

export function setChatWidth(id: ChatWidthId): void {
	persist(CHAT_WIDTH_KEY, id);
	applyChatDisplay(currentChatFont(), id);
}

/** 订阅变更（含其它标签页改同一项时的 `storage` 事件） */
export function onChatDisplayChange(callback: (state: { font: number; width: ChatWidthId }) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<{ font: number; width: ChatWidthId }>).detail;
		if (detail) callback(detail);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== CHAT_FONT_KEY && event.key !== CHAT_WIDTH_KEY) return;
		const next = { font: currentChatFont(), width: currentChatWidth() };
		applyChatDisplay(next.font, next.width);
		callback(next);
	};
	window.addEventListener(CHAT_DISPLAY_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(CHAT_DISPLAY_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}
