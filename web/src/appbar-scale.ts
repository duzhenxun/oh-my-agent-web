/**
 * 顶栏（appbar）整体大小：**一个系数管整条栏**（设置 → 外观 → 顶栏高度）。
 *
 * 与字号那几块（`font-scale.ts` / `sidebar-font.ts`）同一套做法：纯本机偏好、
 * `localStorage`、`agent-web.` 前缀、**首帧前就生效**（写到 `<html>` 的 CSS 变量
 * `--appbar-scale` 上），不进快照、不上云。
 *
 * 为什么是"一个系数"而不是"高度 + 字号 + 内边距"三个滑杆：
 * 顶栏里全是「图标 + 文字 + 内边距」拼出来的小胶囊，单独调高度只会把内容裁掉或留白；
 * 用户要的是"这条栏及里面所有元素一起变小/变大"，那就是一个比例。
 * CSS 侧（app-bar.css / engine-picker.css / agents.css）把每个数字都写成
 * `calc(<原值> * var(--ab))`，`--ab` 在 `.appbar` 里等于本文件的系数，别处恒为 1 ——
 * 于是同一个类（如 `.side-foot-icon`）在顶栏里跟着缩，在别处保持原样。
 *
 * 100% = **现在的标准大小**（默认档）；默认就是 100%（= 快捷卡「标准」）。
 *
 * 刻度重定过一次基准（2026-10-29 用户：「顶高度 标注要写 100」）：以前 100% 指「CSS 原值」，
 * 而用户觉得舒服的那一档是旧刻度的 115%，于是那个 115% 看着像个怪数。现在把**那一档改叫 100%**，
 * 物理大小一斤不动：CSS 侧乘的是 `percent / 100 * 1.15`（见 `CSS_PER_HUNDRED_PERCENT`），
 * 旧存储的百分比也按 1.15 折算过来（115 → 100），用户看到的尺寸不会因为这次改名而变。
 */
const APPBAR_SCALE_KEY = "agent-web.appbar-scale.v2";
/** 旧刻度的键（100 = CSS 原值）：只读一次，按 1.15 折算写进 v2，之后不再使用 */
const LEGACY_APPBAR_SCALE_KEY = "agent-web.appbar-scale";

/**
 * 新刻度的 100% 在 CSS 里到底是多少倍 —— **1.15**。
 *
 * 来历：旧刻度下用户选定的「标准」是 115%，而 `--appbar-scale` 是直接乘进 `calc()` 的，
 * 所以 115% 就等于 1.15。重定基准只改**显示的百分比**，不改这 1.15，于是视觉上一切照旧。
 */
const CSS_PER_HUNDRED_PERCENT = 1.15;

/** 滑杆区间（百分比）：60% 已经很紧（图标 18→12.4px），120% 再大顶栏就要占掉小半屏了 */
export const APPBAR_SCALE_MIN = 60;
export const APPBAR_SCALE_MAX = 120;
/** 步长 5%：够细（差 5% 眼睛能看出来），又不会拖出 87.3% 这种怪数 */
export const APPBAR_SCALE_STEP = 5;

/** 默认 100% = 快捷卡「标准」（用户 2026-10-29：标注写 100，默认也就是这一档） */
const DEFAULT_APPBAR_SCALE = 100;

type AppbarScaleId = "s" | "m" | "l" | "xl";

type AppbarScalePreset = {
	id: AppbarScaleId;
	/** 卡片上的名字（中文，`t()` 的第一参） */
	label: string;
	labelEn: string;
	/** 百分比（100 = 现在的标准大小；乘 1.15 后才是 CSS 倍数） */
	percent: number;
};

/**
 * 四档快捷卡（和字号那排一样：点一下到位，省得拖着找）。
 *
 * 2026-10-29 两次调整：
 *  ① 先把「标准」抬到当时觉得舒服的那一档（旧刻度 115%），顶档改叫「特大」并再放大；
 *  ② 再把**那一档改标成 100%**（用户：「顶高度 标注要写 100」）—— 也就是现在这张表，
 *    物理大小跟 ① 完全一致：60%→0.69、75%→0.86、100%→1.15、120%→1.38。
 */
export const APPBAR_SCALE_PRESETS: readonly AppbarScalePreset[] = [
	{ id: "s", label: "特小", labelEn: "Tiny", percent: 60 },
	{ id: "m", label: "紧凑", labelEn: "Compact", percent: 75 },
	{ id: "l", label: "标准", labelEn: "Standard", percent: 100 },
	{ id: "xl", label: "特大", labelEn: "Extra large", percent: 120 },
];

/**
 * 夹到滑杆区间内并对齐步长。
 *
 * 为什么在这里就规整：滑杆会给 87.00000001 这种浮点尾巴，直接写进 CSS 变量再 `calc`
 * 会算出 14.7900000016px 这种值；而且老存储里可能有 88 这种不在刻度上的数，读取时对齐更稳。
 */
function clampAppbarScale(percent: number): number {
	if (!Number.isFinite(percent)) return DEFAULT_APPBAR_SCALE;
	const clamped = Math.min(Math.max(percent, APPBAR_SCALE_MIN), APPBAR_SCALE_MAX);
	return Math.round(clamped / APPBAR_SCALE_STEP) * APPBAR_SCALE_STEP;
}

/** 纯函数：坏值 / 没存过 → 默认档 */
function readStoredAppbarScale(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw === "") return DEFAULT_APPBAR_SCALE;
	const asNumber = Number(raw);
	if (Number.isFinite(asNumber)) return clampAppbarScale(asNumber);
	// 手改值：当成档位 id 试一下（"m" → 75%、"l" → 100%）
	const preset = APPBAR_SCALE_PRESETS.find((item) => item.id === raw);
	return preset ? preset.percent : DEFAULT_APPBAR_SCALE;
}

/** 旧刻度（100 = CSS 原值）的四档百分比：迁移时先取它，再除 1.15 落回新刻度 */
const LEGACY_PRESET_PERCENT: Record<string, number> = { s: 70, m: 85, l: 100, xl: 115 };

/**
 * 纯函数：旧刻度（100 = CSS 原值）的存储值 → 新刻度百分比。
 *
 * 旧 115% → 新 100%、旧 85% → 新 75%、旧 70% → 新 60%、旧 140% → 新 120%：
 * **物理大小一个像素都不变**，只是数字换了坐标系（用户要看到「标注写 100」）。
 */
function migrateLegacyAppbarScale(raw: string): number {
	const asNumber = Number(raw);
	// 手改的档位 id（旧版存过 "m"）按旧表换算；认不出来的就当旧刻度 100%
	const oldPercent = Number.isFinite(asNumber) ? asNumber : (LEGACY_PRESET_PERCENT[raw] ?? 100);
	return clampAppbarScale(oldPercent / CSS_PER_HUNDRED_PERCENT);
}

/** 纯函数：百分比 → CSS 变量取值（无单位数字，`calc(6px * 1.15)` 靠它算） */
function appbarScaleCss(percent: number): string {
	// 先按新刻度换回倍数，再乘基准 1.15；最后四位小数收一下（0.6900000000000001 → 0.69）
	const factor = (clampAppbarScale(percent) / 100) * CSS_PER_HUNDRED_PERCENT;
	return String(Math.round(factor * 10_000) / 10_000);
}

/** 这个百分比正好等于某一档吗（是 → 那张快捷卡高亮；两档之间返回 null） */
export function presetOfAppbarScale(percent: number): AppbarScaleId | null {
	const value = clampAppbarScale(percent);
	return APPBAR_SCALE_PRESETS.find((item) => item.percent === value)?.id ?? null;
}

/** 变更事件：`<html>` 的变量变了但 React 不知道，用它通知设置面板里的选中态 */
const APPBAR_SCALE_EVENT = "agent-web:appbar-scale";

function readStored(): number {
	if (typeof localStorage === "undefined") return DEFAULT_APPBAR_SCALE;
	try {
		const current = localStorage.getItem(APPBAR_SCALE_KEY);
		if (current !== null && current !== "") return readStoredAppbarScale(current);
		/* 没有新键：看看旧刻度下有没有存过值。有就折算一次（用户看不到任何变化），
		 * 并写进新键 —— 不迁的话所有老用户下次开机就跳到新刻度的 115%（= 旧 132%，明显变大）。 */
		const legacy = localStorage.getItem(LEGACY_APPBAR_SCALE_KEY);
		if (legacy === null || legacy === "") return DEFAULT_APPBAR_SCALE;
		const migrated = migrateLegacyAppbarScale(legacy);
		try {
			localStorage.setItem(APPBAR_SCALE_KEY, String(migrated));
		} catch {
			// 写不进去（隐私模式等）：本次已经用上迁移值了，下次开机再折一遍就行
		}
		return migrated;
	} catch {
		return DEFAULT_APPBAR_SCALE; // 隐私模式禁 localStorage：用默认值，不抛错
	}
}

export function currentAppbarScale(): number {
	return readStored();
}

/** 把系数写到 `<html>` 上并广播一次变更 */
function applyAppbarScale(percent: number): void {
	const value = clampAppbarScale(percent);
	document.documentElement.style.setProperty("--appbar-scale", appbarScaleCss(value));
	window.dispatchEvent(new CustomEvent<number>(APPBAR_SCALE_EVENT, { detail: value }));
}

/** 首帧前调用（`main.tsx`）：读存储并应用 */
export function initAppbarScale(): void {
	applyAppbarScale(readStored());
}

export function setAppbarScale(percent: number): void {
	const value = clampAppbarScale(percent);
	try {
		localStorage.setItem(APPBAR_SCALE_KEY, String(value));
	} catch {
		// 存不下就只在本页生效（与主题 / 字号同一处理）
	}
	applyAppbarScale(value);
}

/** 订阅变更（含其它标签页改同一项时的 `storage` 事件） */
export function onAppbarScaleChange(callback: (percent: number) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<number>).detail;
		if (typeof detail === "number") callback(detail);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== APPBAR_SCALE_KEY) return;
		const next = readStored();
		applyAppbarScale(next);
		callback(next);
	};
	window.addEventListener(APPBAR_SCALE_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(APPBAR_SCALE_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}
