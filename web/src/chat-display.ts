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
 *   --chat-max-width   对话列的宽带上限（`100%` = 满宽）
 */
import { DEFAULT_FONT_PX, clampFontPx, fontPxCss, readStoredFontPx, upgradeStoredFontPx } from "./font-scale.ts";

type ChatWidthId = "narrow" | "normal" | "wide" | "full";

type ChatWidthDef = { id: ChatWidthId; label: string; labelEn: string; /** 0 = 满宽（不限制） */ px: number };

/**
 * 宽度：默认 `full` = 不限制（原先就是铺满对话区）。
 * 窄/标准/宽只是给「一行太长读着累」的人一个上限，列会居中。
 *
 * 这四档现在只是**滑杆旁边的快捷卡**（点一下就到位）；真正的状态是一个像素值（见下）。
 */
export const CHAT_WIDTHS: readonly ChatWidthDef[] = [
	{ id: "narrow", label: "窄", labelEn: "Narrow", px: 720 },
	{ id: "normal", label: "标准", labelEn: "Default", px: 900 },
	{ id: "wide", label: "宽", labelEn: "Wide", px: 1100 },
	{ id: "full", label: "满宽", labelEn: "Full width", px: 0 },
];

/**
 * 宽度滑杆：**480px 起，右端就是「满屏」**。
 *
 * 2026-10-30 用户：「也加一个滑动条吧，但最大只能是满屏」——
 * 所以右端不是一个写死的数字，而是 `chatWidthCap()` 量出来的「对话区实际可用宽度」：
 * 拖到最右 = 不限制（= 满宽），再往右本来也没有意义。
 * 左端 480px：再窄就不是「读得舒服」而是「挤成一根条」了（窄屏本来也会自动铺满）。
 */
export const CHAT_WIDTH_MIN_PX = 480;
/** 滑杆步长：20px。再细就是无意义的拖拽精度，再粗就跳得肉眼可见 */
export const CHAT_WIDTH_STEP_PX = 20;

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

export function findChatWidth(id: string | null | undefined): ChatWidthDef | null {
	return CHAT_WIDTHS.find((item) => item.id === id) ?? null;
}

/** 纯函数：坏值 / 老档位 / 没存过 → 像素字号（默认 14px，且会对到偶数） */
export function readStoredFont(raw: string | null): number {
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

export function readStoredWidth(raw: string | null): number {
	if (raw === null || raw === "") return 0;
	// 老版本存的是档位 id（narrow/normal/wide/full）：照旧认，映射成对应的像素
	const legacy = findChatWidth(raw);
	if (legacy) return legacy.px;
	// 新版本存的是像素：非数字（含 `"9999px"` 这种带单位的）一律当坏值 → 满宽
	return /^\d+$/.test(raw.trim()) ? clampChatWidthPx(Number(raw)) : 0;
}

/**
 * 夹到滑杆区间并对齐步长（`0` = 满宽，原样返回）。
 *
 * 为什么在这里就规整：老存储里可能有 937 这种不在 20 步长上的值，直接写进 `--chat-max-width`
 * 再读回来会拖一串小数；对齐之后滑杆的当前值也一定落在刻度上。
 */
export function clampChatWidthPx(px: number): number {
	if (!Number.isFinite(px) || px <= 0) return 0;
	const steps = Math.round((px - CHAT_WIDTH_MIN_PX) / CHAT_WIDTH_STEP_PX);
	return CHAT_WIDTH_MIN_PX + Math.max(0, steps) * CHAT_WIDTH_STEP_PX;
}

/**
 * 滑杆右端：**满屏**（对话区实际可用的宽度）。
 *
 * 为什么量出来而不是写死一个数：这里的「满宽」是「铺满可用区域」，跟窗口多宽、侧栏
 * 有没有折起来都有关系 —— 写死 1600 的话，1280 的窗口上拖到头也还差一截，2560 的
 * 窗口上又够不到满宽。量一下，拖到最右就是真的满宽（用户 2026-10-30 的要求）。
 *
 * 量的是 `.workspace` 的内容宽度：`--chat-max-width` 那几条
 * `calc((100% - var(--chat-max-width)) / 2)` 里的 `100%` 就是它
 * （padding 的百分比按包含块的内容宽度算）。
 * 取整到步长上并且**向下取**：滑杆的 max 必须自己落在刻度上，否则最后一格永远拖不到。
 * 量不到（没有会话、面板从别处打开）就按窗口估一个保守值。
 */
export function chatWidthCap(): number {
	const align = (value: number): number =>
		CHAT_WIDTH_MIN_PX + Math.max(1, Math.floor((value - CHAT_WIDTH_MIN_PX) / CHAT_WIDTH_STEP_PX)) * CHAT_WIDTH_STEP_PX;
	const fallback = (): number => {
		const viewport = typeof window === "undefined" ? 1440 : window.innerWidth || 1440;
		// 侧栏 + 大纲 + 两侧留白大概吃掉 320px；再小也别低于 720，不然滑杆区间只剩几格
		return align(Math.max(720, viewport - 320));
	};
	if (typeof document === "undefined") return fallback();
	const workspace = document.querySelector(".workspace");
	if (!(workspace instanceof HTMLElement)) return fallback();
	const style = getComputedStyle(workspace);
	const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
	const width = workspace.clientWidth - padding;
	return width > CHAT_WIDTH_MIN_PX + CHAT_WIDTH_STEP_PX ? align(width) : fallback();
}

/** 纯函数：字号（像素）+ 宽度（像素，0 = 满宽）对应的 CSS 变量取值（不碰 DOM） */
export function cssVarsOf(fontPx: number, widthPx: number): { size: string; maxWidth: string } {
	const size = fontPxCss(fontPx);
	// 满宽用 `100%` 而不是 `none`：布局那边要拿它做 `calc((100% - var(--chat-max-width)) / 2)`，
	// `none` 会让整条 calc 失效（虽然也能退化成原来的样子，但那是靠"声明被丢掉"实现的，太隐晦）
	return { size, maxWidth: widthPx > 0 ? `${widthPx}px` : "100%" };
}

export function currentChatFont(): number {
	return readFontWithLegacy(DEFAULT_FONT_PX.chat);
}

/** 当前宽度（像素；0 = 满宽） */
export function currentChatWidth(): number {
	const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CHAT_WIDTH_KEY);
	return readStoredWidth(raw);
}

/** 把两个变量写到 `<html>` 上并广播一次变更 */
function applyChatDisplay(font: number, width: number): void {
	const vars = cssVarsOf(font, width);
	const style = document.documentElement.style;
	style.setProperty("--chat-font-size", vars.size);
	style.setProperty("--chat-max-width", vars.maxWidth);
	/**
	 * 宽度也挂到 `<html data-chat-width>` 上：**满宽**要额外把左边那截留白收窄。
	 *
	 * 光靠变量做不到 —— `--chat-max-width` 在满宽时是 100%，CSS 没法问"这个值是不是满的"。
	 * 而左留白有两截（`.workspace` 的 20px + 内容的 16px），限宽时被居中计算掩盖了，
	 * 满宽时却原样留着，看起来"明明铺满了，左边还空一条"。
	 * 现在是连续像素值，所以只分两种：`full` / `custom`（CSS 只认前一个）。
	 */
	document.documentElement.dataset.chatWidth = width > 0 ? "custom" : "full";
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

export function setChatWidth(px: number): void {
	const value = clampChatWidthPx(px);
	persist(CHAT_WIDTH_KEY, String(value));
	applyChatDisplay(currentChatFont(), value);
}

/** 订阅变更（含其它标签页改同一项时的 `storage` 事件） */
export function onChatDisplayChange(callback: (state: { font: number; width: number }) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<{ font: number; width: number }>).detail;
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
