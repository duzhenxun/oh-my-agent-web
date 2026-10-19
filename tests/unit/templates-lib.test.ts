/**
 * 模板库软删除（P5）：内置模板「移出」只隐藏，自建模板真删。
 * 这条区分的意义：手滑删掉一条默认项之后，「恢复默认模板」还能救回来。
 */
import { describe, expect, it } from "vitest";
import { isBuiltin, removeTemplate, visibleTemplates } from "../../web/src/templates-lib.ts";
import type { PromptTemplate } from "../../web/src/types.ts";

const builtin: PromptTemplate = { id: "t-review", name: "代码审查", description: "", icon: "🧹", text: "审查当前改动" };
const custom: PromptTemplate = { id: "tpl-abc", name: "我的模板", description: "", icon: "✳️", text: "做点事" };

describe("移出模板库", () => {
	it("内置模板只标记 hidden（留在库里，可恢复）", () => {
		const next = removeTemplate([builtin, custom], builtin.id);
		expect(next).toHaveLength(2);
		expect(next[0]?.hidden).toBe(true);
		expect(visibleTemplates(next).map((item) => item.name)).toEqual(["我的模板"]);
	});

	it("自建模板真删", () => {
		const next = removeTemplate([builtin, custom], custom.id);
		expect(next).toHaveLength(1);
		expect(next[0]?.id).toBe(builtin.id);
	});

	it("不存在的 id 不动库，也不改原数组", () => {
		const list = [builtin, custom];
		const next = removeTemplate(list, "没这个");
		expect(next).toHaveLength(2);
		expect(list[0]?.hidden).toBeUndefined();
	});
});

describe("isBuiltin", () => {
	it("按 id 前缀识别", () => {
		expect(isBuiltin(builtin)).toBe(true);
		expect(isBuiltin(custom)).toBe(false);
	});
});
