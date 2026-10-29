/**
 * 语言（设置 → 语言）：中文 / English，**默认中文**。
 *
 * 为什么先做成「本机偏好」而不是服务端设置：界面语言是「这台机器上怎么显示」，
 * 和主题、栏宽同一类（见 ui-prefs.ts 的判据）；一个人用电脑看中文、用手机看英文也很正常。
 * 存 localStorage，点一下立刻生效，不进快照、不影响别的设备。
 *
 * 文案怎么翻：不引 i18n 框架、也不建 key 表 —— 这个项目的界面文字全是「就地写的中文」，
 * 建 key 表等于把几百条中文再抄一遍，改动面比收益大。用 `t("中文", "English")` 就地并列，
 * 看到哪句翻哪句，没翻的自然回落中文（`t` 的第二参可以慢慢补）。
 */

export type Language = "zh" | "en";

/** 存储键（前缀与 ui-prefs 的 `agent-web.*` 一致；两处都用 `agent-web.` 命名） */
export const LANGUAGE_KEY = "agent-web.language";

/** 同页通知（跨标签页靠 `storage` 事件，见 useLanguage） */
const LANGUAGE_EVENT = "agent-web:language";

/**
 * 语言选项（顺序就是设置里的顺序）。名字是**自称**，不跟着界面语言变：
 * 界面是英文时也要能看见「中文」这两个字，否则用户找不到切回去的入口。
 */
export const LANGUAGES: { id: Language; label: string }[] = [
	{ id: "zh", label: "中文" },
	{ id: "en", label: "English" },
];

const DEFAULT_LANGUAGE: Language = "zh";

export function readLanguage(): Language {
	try {
		const raw = localStorage.getItem(LANGUAGE_KEY);
		return raw === "en" ? "en" : DEFAULT_LANGUAGE;
	} catch {
		return DEFAULT_LANGUAGE; // 隐私模式读不了 localStorage：用默认值，不抛错
	}
}

export function writeLanguage(next: Language): void {
	try {
		localStorage.setItem(LANGUAGE_KEY, next);
	} catch {
		// 存不下就只在本页生效
	}
	applyDocumentLang(next);
	window.dispatchEvent(new CustomEvent<Language>(LANGUAGE_EVENT, { detail: next }));
}

/** `<html lang>`：给读屏和浏览器（断词、翻译提示）用，跟界面语言保持一致 */
export function applyDocumentLang(language: Language): void {
	try {
		document.documentElement.lang = language === "en" ? "en" : "zh-CN";
	} catch {
		// 非浏览器环境（测试）忽略
	}
}
