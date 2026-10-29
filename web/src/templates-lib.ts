/**
 * 模板库的纯函数（P5）：可见性过滤 + 「移出模板库」的真实语义。
 *
 * 关键取舍：**内置模板只能隐藏，不能真删**——它是默认项，真删了就再也回不来
 * （「恢复默认模板」也救不回一条你手滑删掉的默认项）。用户自建模板则真删。
 */
import type { PromptTemplate } from "./types.ts";

/** 卡片墙上要显示的模板（隐藏的不显示） */
export function visibleTemplates(templates: PromptTemplate[]): PromptTemplate[] {
	return templates.filter((template) => template.hidden !== true);
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
