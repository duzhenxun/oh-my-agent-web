/**
 * 文件预览的纯函数（M4 增强）：语言判定、行范围、对话引用语法。
 */
import { describe, expect, it } from "vitest";
import { describeRange, languageOf, normalizeRange, referenceFor } from "../../web/src/file-preview.ts";

describe("languageOf（按扩展名选高亮语言）", () => {
	it("常见扩展名", () => {
		expect(languageOf("server/index.ts")).toBe("typescript");
		expect(languageOf("web/src/App.tsx")).toBe("typescript");
		expect(languageOf("a.mjs")).toBe("javascript");
		expect(languageOf("package.json")).toBe("json");
		expect(languageOf("styles.css")).toBe("css");
		expect(languageOf("README.md")).toBe("markdown");
		expect(languageOf("deploy/pi-web-ui.service")).toBe("");
	});

	it("无扩展名的特殊文件名", () => {
		expect(languageOf("Dockerfile")).toBe("dockerfile");
		expect(languageOf("Makefile")).toBe("makefile");
	});

	it("大小写不敏感", () => {
		expect(languageOf("A.TS")).toBe("typescript");
	});
});

describe("normalizeRange（点选与 Shift+点选）", () => {
	it("0-based 锚点/焦点换算成 1-based 范围（自动换序）", () => {
		expect(normalizeRange(9, 9)).toEqual({ start: 10, end: 10 });
		expect(normalizeRange(19, 9)).toEqual({ start: 10, end: 20 });
		expect(normalizeRange(9, 19)).toEqual({ start: 10, end: 20 });
	});
});

describe("referenceFor（只给路径引用，不注入内容）", () => {
	it("没选中 = 整文件引用", () => {
		expect(referenceFor("server/index.ts", null)).toBe("@server/index.ts");
	});

	it("单行不带区间，多行带 a-b", () => {
		expect(referenceFor("a.ts", { start: 10, end: 10 })).toBe("@a.ts:10");
		expect(referenceFor("a.ts", { start: 10, end: 20 })).toBe("@a.ts:10-20");
	});

	it("引用里不含文件内容（ADR-0002 的原则）", () => {
		const reference = referenceFor("src/a.ts", { start: 1, end: 3 });
		expect(reference).not.toContain("\n");
		expect(reference.length).toBeLessThan(120);
	});
});

describe("describeRange", () => {
	it("给人看的选中描述", () => {
		expect(describeRange(null)).toBe("未选中");
		expect(describeRange({ start: 10, end: 10 })).toBe("第 10 行");
		expect(describeRange({ start: 10, end: 10 }) === "第 10–10 行").toBe(false);
		expect(describeRange({ start: 10, end: 20 })).toBe("第 10–20 行");
	});
});
