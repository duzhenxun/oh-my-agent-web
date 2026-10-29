/**
 * 外观主题（设置 → 外观，ADR-0030）。
 *
 * **为什么存 localStorage 而不是走 `set_settings` 快照**：主题必须在**首帧之前**生效 ——
 * 服务端往返一圈太晚，会先白一下再变深色，闪得很难看。它和侧栏宽度、弹窗尺寸是同一类
 * 「纯界面偏好」，所以走同一套纪律：localStorage + `agent-web.` 前缀，不进快照、不上云。
 *
 * 生效方式是给 `<html>` 挂两个属性，`styles/theme.css` 按它们选色板：
 *   data-theme="dark-night"   具体色板（`theme.css` 里一个块一个色板）
 *   data-theme-mode="dark"    亮/暗两大类（代码高亮、状态色按这个切）
 *
 * mode 由 id 前缀推出来（`light` / `dark`），**不单独存** —— 这样 `index.html` 里那段
 * 首帧前跑的内联脚本只需要一条前缀判断，不会和这里的表各说各话。
 */
type ThemeMode = "light" | "dark";
export type ThemeId = "light" | "light-warm" | "light-cool" | "dark" | "dark-night" | "dark-warm";

export type ThemeDef = {
	id: ThemeId;
	name: string;
	hint: string;
	/** 三色预览：[底, 卡片, 主色]，设置面板的色卡直接用 */
	swatch: [string, string, string];
};

/** 3 浅 + 3 深。第一个浅色就是改版前的默认配色，所以老用户升级后视觉不变。 */
export const THEMES: readonly ThemeDef[] = [
	{ id: "light", name: "清亮白", hint: "白底蓝调，默认", swatch: ["#ffffff", "#eef1f5", "#1f6feb"] },
	{ id: "light-warm", name: "暖纸", hint: "米白赭石，偏护眼", swatch: ["#fbf7f0", "#eee4d4", "#b4530a"] },
	{ id: "light-cool", name: "雾青", hint: "冷灰墨绿，最冷静", swatch: ["#f6f9f9", "#e3ecec", "#0f766e"] },
	{ id: "dark", name: "东京夜", hint: "蓝紫夜色，Tokyo Night", swatch: ["#1a1b26", "#292e42", "#7aa2f7"] },
	{ id: "dark-night", name: "摩卡", hint: "低饱和紫灰，Catppuccin", swatch: ["#1e1e2e", "#313244", "#cba6f7"] },
	{ id: "dark-warm", name: "北境", hint: "冷灰青，最冷静，Nord", swatch: ["#2e3440", "#434c5e", "#88c0d0"] },
];

const THEME_STORAGE_KEY = "agent-web.theme";

/** 主题变更事件（`<html>` 属性变了但 React 不知道，用它通知订阅者，比如 mermaid 重渲染） */
const THEME_EVENT = "agent-web:theme";

/** 从 id 推亮/暗：只认 `light` / `dark` 开头，别的一律当浅色（坏值不该把界面拖进黑夜） */
export function modeOf(id: ThemeId): ThemeMode {
	return id.startsWith("dark") ? "dark" : "light";
}

function findTheme(id: string | null | undefined): ThemeDef | null {
	return THEMES.find((theme) => theme.id === id) ?? null;
}

/** 纯函数：坏值 / 没存过 → 默认「清亮白」（改版前的配色，不给人惊喜） */
function readStoredTheme(raw: string | null): ThemeId {
	const found = findTheme(raw);
	return found ? found.id : "light";
}

let current: ThemeDef = THEMES[0] as ThemeDef;

export function currentTheme(): ThemeDef {
	return current;
}

/** 应用主题：挂属性 + 同步浏览器 UI 色（手机地址栏 / PWA 状态栏跟着走） */
function applyTheme(id: ThemeId): ThemeDef {
	const theme = findTheme(id) ?? (THEMES[0] as ThemeDef);
	current = theme;
	const root = document.documentElement;
	root.setAttribute("data-theme", theme.id);
	root.setAttribute("data-theme-mode", modeOf(theme.id));
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
		meta.setAttribute("content", bg || theme.swatch[0]);
	}
	window.dispatchEvent(new CustomEvent<ThemeDef>(THEME_EVENT, { detail: theme }));
	return theme;
}

/** 首帧前调用（`main.tsx`）：读存储并应用。返回生效的主题 id */
export function initTheme(): ThemeId {
	const stored = readStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
	return applyTheme(stored).id;
}

export function setTheme(id: ThemeId): void {
	applyTheme(id);
	try {
		localStorage.setItem(THEME_STORAGE_KEY, id);
	} catch {
		// 隐私模式 / 存储被禁：主题只在本页生效，不报错
	}
}

/** 订阅主题变更（含其他标签页改同一项时的 `storage` 事件） */
export function onThemeChange(callback: (theme: ThemeDef) => void): () => void {
	const onCustom = (event: Event) => callback((event as CustomEvent<ThemeDef>).detail ?? current);
	const onStorage = (event: StorageEvent) => {
		if (event.key !== THEME_STORAGE_KEY) return;
		callback(applyTheme(readStoredTheme(event.newValue)));
	};
	window.addEventListener(THEME_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(THEME_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}
