/**
 * 语言（设置 → 语言）：English / 中文，**英文是默认**。
 *
 * 首次进入跟浏览器走：浏览器首选语言是中文（`zh` / `zh-CN` / `zh-TW`…）就用中文，
 * 其余一律英文 —— 英文是兵底，中文是「浏览器说中文」才给的特例。
 * 用户手动切过之后就只认存下来的那个值，再不看浏览器（"后面用户手动设置过就按用户设置的来"）。
 *
 * 为什么不把检测结果写回存储：写回去等于把"猜的"变成"用户选的"，
 * 以后用户把浏览器语言改成中文也不会生效了。存储里**只有用户真点过**的那个值。
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

/** 存设里什么都没有、又拿不到浏览器语言（测试 / 老浏览器）时的兵底：**英文** */
const DEFAULT_LANGUAGE: Language = "en";

/**
 * 语言选项（顺序就是设置里的顺序）。名字是**自称**，不跟着界面语言变：
 * 界面是英文时也要能看见「中文」这两个字，否则用户找不到切回去的入口。
 */
export const LANGUAGES: { id: Language; label: string }[] = [
	{ id: "zh", label: "中文" },
	{ id: "en", label: "English" },
];

/** 浏览器的首选语言（拿不到就给 null，别编一个出来） */
function browserLanguage(): string | null {
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const primary = nav?.languages?.[0] ?? nav?.language;
	return typeof primary === "string" && primary.trim() !== "" ? primary.trim() : null;
}

/**
 * 首次进入用哪种语言：中文浏览器 → 中文（`zh` / `zh-CN` / `zh-Hans` / `zh-TW` 都算），
 * 其余任何语言 → 英文（英文是默认）。导出是为了能在单测里直接断言，不改任何状态。
 */
export function detectLanguage(): Language {
	const primary = browserLanguage();
	if (primary === null) return DEFAULT_LANGUAGE;
	return /^zh/i.test(primary) ? "zh" : "en";
}

/**
 * 当前语言：**存过的优先**（那是用户手动点过的），没存过才看浏览器。
 * 注意「存过但值是脏的」（手改 localStorage / 旧版本写的）也走检测，别把用户锁在中文上。
 */
export function readLanguage(): Language {
	try {
		const raw = localStorage.getItem(LANGUAGE_KEY);
		if (raw === "zh" || raw === "en") return raw;
		return detectLanguage();
	} catch {
		return detectLanguage(); // 隐私模式读不了 localStorage：按浏览器语言走，不抛错
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
