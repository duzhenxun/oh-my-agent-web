/**
 * 网页面板的「手机尺寸预览」：把 iframe 装进一个固定手机视口的机身里。
 *
 * 为什么这就够用（不去做「真机模拟」）：页面的响应式断点看的是**视口宽度**，
 * 而 iframe 的宽度就是它自己的视口 —— 把 iframe 收成 390px，页面里的 `@media (max-width: …)`
 * 就按手机那一档走，跟真机上看到的是同一套布局。做不到的只有设备相关的东西
 * （User-Agent、`devicePixelRatio`、触屏事件、`viewport` 缩放）——
 * 那些在沙箱 iframe 里改不了，也不该假装能改。
 *
 * 纯函数放这里（`tests/unit/phone-frame.test.ts` 直接钉住）：机型表、按 id 取机型、缩放比。
 */

export type PhonePreset = {
	/** 存进 localStorage 的就是它；改名字会导致老用户的选择丢失，所以它是**稳定 id** */
	id: string;
	/** 选择器里显示的名字 */
	label: string;
	/** CSS 像素，与真机竖屏视口一致 */
	width: number;
	height: number;
};

/**
 * 常用机型（竖屏 CSS 视口尺寸）。
 *
 * 为什么是这几个：一个最小档（SE，看 375 这一档断点）、两个主流 iPhone 尺寸、
 * 一个安卓常见宽度（360/412 这两档在安卓上最常见），再加一个平板宽度
 * （很多人要的就是「窄屏 vs 宽屏」两档对比，顺带能验平板）。
 */
export const PHONE_PRESETS: readonly PhonePreset[] = [
	{ id: "se", label: "iPhone SE 375×667", width: 375, height: 667 },
	{ id: "iphone14", label: "iPhone 14 390×844", width: 390, height: 844 },
	{ id: "promax", label: "iPhone 15 Pro Max 430×932", width: 430, height: 932 },
	{ id: "android", label: "Android 360×800", width: 360, height: 800 },
	{ id: "tablet", label: "平板 768×1024", width: 768, height: 1024 },
] as const;

export const PHONE_PRESET_DEFAULT = "iphone14";

/** 存过什么就用什么；手改 localStorage、或机型表里删掉了某个 id，都退回默认那台 */
export function phonePresetOf(id: string | null | undefined): PhonePreset {
	const found = PHONE_PRESETS.find((preset) => preset.id === id);
	return found ?? PHONE_PRESETS.find((preset) => preset.id === PHONE_PRESET_DEFAULT) ?? PHONE_PRESETS[0];
}

/**
 * 缩放比：面板放不下整台手机时等比缩小，**永远不放大**（`min(…, 1)`）。
 *
 * 为什么不放大：放大只会让面板里的字看着比真机更大，反而看不准「手机上是不是挤」。
 * 同时按下限 0.25 兜一下：再小就只剩一个缩略图，不如让它溢出（调用方一般不会走到这一步）。
 */
export function fitScale(available: { width: number; height: number }, preset: PhonePreset, padding = 12): number {
	if (available.width <= 0 || available.height <= 0) return 1;
	const scale = Math.min(
		(available.width - padding * 2) / preset.width,
		(available.height - padding * 2) / preset.height,
		1,
	);
	if (!Number.isFinite(scale)) return 1;
	return Math.max(0.25, Math.round(scale * 100) / 100);
}
