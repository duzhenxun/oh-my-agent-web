/**
 * 模板库的纯函数（P5）：可见性过滤 + 「移出模板库」的真实语义。
 *
 * 关键取舍：**内置模板只能隐藏，不能真删**——它是默认项，真删了就再也回不来
 * （「恢复默认模板」也救不回一条你手滑删掉的默认项）。用户自建模板则真删。
 */
import type { Language } from "./language.ts";
import type { PromptTemplate, QuickPhrase } from "./types.ts";

/** 卡片墙上要显示的模板（隐藏的不显示） */
export function visibleTemplates(templates: PromptTemplate[]): PromptTemplate[] {
	return templates.filter((template) => template.hidden !== true);
}

/**
 * 内置内容的**第二份：按界面语言取**（2026-11-23）。
 *
 * 模板和快捷指令都是**内容**（会被插进输入框 / 发出去），不是界面文案 ——
 * 所以不能靠 `t("中文", "English")`，而是数据里存两份、由服务端在归一化时补上 `*En`
 *（规则见 `server/session/settings.ts` 的 `normalizeTemplates` / `normalizeQuickPhrases`）。
 *
 * 这里只做「取哪一份」：界面是英文**且**有英文副本才用英文，否则一律用存下来的原文。
 * 用户自己写的模板 / 短语没有英文副本（也不该被偷着翻），两种语言下都原样显示。
 */
export function localizeTemplate(
	template: PromptTemplate,
	language: Language,
): { name: string; description: string; text: string } {
	if (language !== "en") return { name: template.name, description: template.description, text: template.text };
	return {
		name: template.nameEn || template.name,
		description: template.descriptionEn || template.description,
		text: template.textEn || template.text,
	};
}

/**
 * 快捷指令按语言取（英文界面 + 有英文副本 → 英文那条，否则原文）。
 *
 * 容忍**老形状**：`settings.quickPhrases` 以前是 `string[]`（一行一条，没有英文副本），
 * 服务端归一化之前快照里可能还是字符串 —— 这时直接把它当原文返回。
 * 不做这层容错的话，`phrase.text` 会是 undefined，界面上就出现一排**空胶囊**
 * （用户 2026-11-23 截图：「为什么网页里看不到呢」就是这个）。
 */
export function localizePhrase(phrase: QuickPhrase | string, language: Language): string {
	if (typeof phrase === "string") return phrase;
	const text = phrase.text ?? "";
	return language === "en" && phrase.textEn ? phrase.textEn : text;
}

/** 内置模板的判定（沿用 id 约定：默认项都是 `t-` 开头） */
export function isBuiltin(template: PromptTemplate): boolean {
	return template.id.startsWith("t-");
}

/**
 * 移出模板库：内置 → 标记 hidden（可恢复）；自建 → 从库里移除。
 * 返回新数组，不改原数组。
 */
export function removeTemplate(templates: PromptTemplate[], id: string): PromptTemplate[] {
	return templates.flatMap((template) => {
		if (template.id !== id) return [template];
		if (!isBuiltin(template)) return [];
		return [{ ...template, hidden: true }];
	});
}
