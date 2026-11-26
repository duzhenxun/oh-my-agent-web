/**
 * 内置内容的**第二份：英文**（`server/session/settings.ts` + `web/src/templates-lib.ts`）。
 *
 * 用户 2026-11-23：「这个如果是英文得自动显示英文的」「是不是可以保存 2 份呢」
 * → 模板与快捷指令都是**内容**（要插进输入框 / 发出去），所以存两份、按界面语言取。
 *
 * 这里钉住三件事：
 *   1. 内置项确实两份都齐（英文非空、不夹中文、不超字段上限）；
 *   2. **老的纯中文数据升级上来也能显示英文**（settings.json 里存的是中文原文，
 *      归一化时按「原文还等于内置原文」补第二份）；
 *   3. 用户改过的内容不被硬塞译文（那一格就不带 `*En`，界面回落原文）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_QUICK_PHRASES,
	DEFAULT_TEMPLATES,
	normalizeQuickPhrases,
	normalizeTemplates,
} from "../../server/session/settings.ts";
import { localizePhrase, localizeTemplate } from "../../web/src/templates-lib.ts";

/** 有没有中日韩字符：英文副本里出现它就是漏翻了一条 */
const hasCJK = (text: string): boolean => /[\u3400-\u9fff\u3000-\u303f]/.test(text);

describe("内置模板：两份都在", () => {
	const normalized = normalizeTemplates(DEFAULT_TEMPLATES);

	it("默认模板全部带英文标题 / 说明 / 正文", () => {
		assert.equal(normalized.length, DEFAULT_TEMPLATES.length);
		for (const template of normalized) {
			assert.ok(template.nameEn, `${template.id} 缺 nameEn`);
			assert.ok(template.descriptionEn, `${template.id} 缺 descriptionEn`);
			assert.ok(template.textEn, `${template.id} 缺 textEn`);
		}
	});

	it("英文副本里不夹中文，长度也不超上限（24 / 60 / 2000）", () => {
		for (const template of normalized) {
			for (const [field, limit] of [
				["nameEn", 24],
				["descriptionEn", 60],
				["textEn", 2000],
			] as const) {
				const value = template[field];
				assert.ok(value, `${template.id} 缺 ${field}`);
				assert.ok(value.length <= limit, `${template.id} 的 ${field} 太长（${value.length}）`);
				assert.equal(hasCJK(value), false, `${template.id} 的 ${field} 还有中文：${value}`);
			}
		}
	});

	it("英文界面取英文、中文界面取原文", () => {
		const spec = normalized[0];
		assert.ok(spec);
		assert.equal(localizeTemplate(spec, "en").name, "Spec to done");
		assert.equal(localizeTemplate(spec, "zh").name, "规格落地");
		assert.match(localizeTemplate(spec, "en").text, /failing tests first/);
	});
});

describe("老 settings.json（纯中文，没有 En 字段）升级", () => {
	it("原文还等于内置原文 → 自动补上英文（不用迁移脚本）", () => {
		const legacy = DEFAULT_TEMPLATES.map(({ name, description, icon, text, id }) => ({
			id,
			name,
			description,
			icon,
			text,
		}));
		const normalized = normalizeTemplates(legacy);
		for (const template of normalized) {
			assert.ok(template.nameEn, `${template.id} 该补上 nameEn`);
			assert.ok(template.textEn, `${template.id} 该补上 textEn`);
		}
	});

	it("用户改过的那一格不再补英文，其余格照旧", () => {
		const [first] = DEFAULT_TEMPLATES;
		assert.ok(first);
		const edited = normalizeTemplates([
			{ id: first.id, name: first.name, description: first.description, icon: first.icon, text: "我的私有提示词" },
		]);
		const template = edited[0];
		assert.ok(template);
		assert.equal(template.textEn, undefined); // 正文被改过：不给译文
		assert.ok(template.nameEn); // 标题没动：仍然有
		assert.ok(template.descriptionEn); // 说明没动：仍然有
	});

	it("自建模板（tpl-*）不会凭空多出英文副本", () => {
		const [created] = normalizeTemplates([{ id: "tpl-abc", name: "我的模板", description: "说明", text: "正文" }]);
		assert.ok(created);
		assert.equal(created.nameEn, undefined);
		assert.equal(created.textEn, undefined);
	});

	it("客户端自己带上来的英文会被保留（用户改过之后仍能居两种语言）", () => {
		const [first] = DEFAULT_TEMPLATES;
		assert.ok(first);
		const saved = normalizeTemplates([
			{
				id: first.id,
				name: first.name,
				description: first.description,
				icon: first.icon,
				text: "custom",
				textEn: "Custom prompt",
			},
		]);
		assert.equal(saved[0]?.textEn, "Custom prompt");
	});
});

describe("内置快捷指令：只有两条，而且两份都在", () => {
	it("默认就两条：继续 / 总结一下，各带英文", () => {
		assert.deepEqual(
			DEFAULT_QUICK_PHRASES.map((phrase) => [phrase.text, phrase.textEn]),
			[
				["继续", "Continue"],
				["总结一下", "Summarize"],
			],
		);
	});

	it("英文界面取英文、中文界面取原文", () => {
		const phrase = DEFAULT_QUICK_PHRASES[0];
		assert.ok(phrase);
		assert.equal(localizePhrase(phrase, "en"), "Continue");
		assert.equal(localizePhrase(phrase, "zh"), "继续");
	});

	it("老数据是纯字符串数组：认得出来，内置那两条补上英文，用户自己那条不动", () => {
		const normalized = normalizeQuickPhrases(["继续", "总结一下", "部署线上"]);
		assert.deepEqual(normalized, [
			{ text: "继续", textEn: "Continue" },
			{ text: "总结一下", textEn: "Summarize" },
			{ text: "部署线上" },
		]);
	});

	it("用户改过措辞的短语不会被翻译（没有英文副本 → 两种语言都原样显示）", () => {
		const normalized = normalizeQuickPhrases([{ text: "继续做，别停" }]);
		assert.deepEqual(normalized, [{ text: "继续做，别停" }]);
		assert.equal(localizePhrase(normalized[0] as never, "en"), "继续做，别停");
	});

	it("空串 / 坏值丢掉，重复的按两份一起判重", () => {
		assert.deepEqual(normalizeQuickPhrases(["  ", "继续", "继续", 42, { text: "  " }]), [
			{ text: "继续", textEn: "Continue" },
		]);
	});
});
