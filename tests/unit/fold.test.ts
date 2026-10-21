/**
 * 代码 / JSON 预览的折叠：只认「跨行」的块，且不能把字符串、注释里的括号算进去。
 */
import { describe, expect, it } from "vitest";
import { computeFolds } from "../../web/src/file-preview.ts";

describe("computeFolds", () => {
	it("JSON：嵌套对象各自可折叠", () => {
		const text = ["{", '  "a": {', '    "b": 1', "  },", '  "c": [', "    1,", "    2", "  ]", "}"].join("\n");
		expect(computeFolds(text)).toEqual([
			{ start: 0, end: 8 },
			{ start: 1, end: 3 },
			{ start: 4, end: 7 },
		]);
	});

	it("同一行闭合的块不算（折叠没意义）", () => {
		expect(computeFolds('{ "a": 1 }')).toEqual([]);
	});

	it("字符串里的括号不算", () => {
		expect(computeFolds('const a = "}";\nconst b = 1;')).toEqual([]);
	});

	it("注释里的括号不算", () => {
		expect(computeFolds("// }\n/* {\n} */\nconst a = 1;")).toEqual([]);
	});

	it("函数体可折叠", () => {
		const text = ["function f() {", "  return 1;", "}"].join("\n");
		expect(computeFolds(text)).toEqual([{ start: 0, end: 2 }]);
	});
});
