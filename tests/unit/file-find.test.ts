/**
 * 代码预览的「查找」（`web/src/file-preview.ts` 里那几个纯函数）。
 *
 * 钉三件事：
 *   - 行号 / 偏移是按**原始文本**算的（高亮只是显示层，不能拿 HTML 去搜）；
 *   - 标 `<mark>` 只动文本节点，标签与 `&quot;` 这类实体原样拼回去，不能把高亮搞崩；
 *   - 跳到藏在折叠块里的命中时，要先把它外面那些块展开。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codeSnippet,
	escapeHtml,
	expandFoldsContaining,
	findInLines,
	markMatches,
	type FoldRange,
} from "../../web/src/file-preview.ts";

describe("findInLines", () => {
	const lines = ['  "act_name": "活动名",', '  "act_time": {', "  // ACT_name 注释"];

	it("大小写不敏感，逐行给出偏移", () => {
		assert.deepEqual(findInLines(lines, "act_name"), [
			{ line: 0, offset: 3 },
			{ line: 2, offset: 5 },
		]);
	});

	it("同一行多处都能找到，且不重叠计数", () => {
		assert.deepEqual(findInLines(["aaaa"], "aa"), [
			{ line: 0, offset: 0 },
			{ line: 0, offset: 2 },
		]);
	});

	it("空关键字 = 没有命中", () => {
		assert.deepEqual(findInLines(lines, ""), []);
	});

	it("命中数有上限（搜一个字母不会把几十万处都塞进内存）", () => {
		assert.equal(findInLines(["x".repeat(100)], "x", 10).length, 10);
	});
});

describe("escapeHtml", () => {
	it("只转义会破坏结构的三个字符", () => {
		assert.equal(escapeHtml('<a href="x"> & </a>'), '&lt;a href="x"&gt; &amp; &lt;/a&gt;');
	});
});

describe("markMatches", () => {
	it("在文本节点里包 <mark>，标签原样保留", () => {
		const html = '<span class="hljs-string">"act_name"</span>: 1';
		const marked = markMatches(html, "act_name", null);
		assert.equal(marked, '<span class="hljs-string">"<mark class="file-find-hit">act_name</mark>"</span>: 1');
	});

	it("当前那一处多一个 -on 类（其余命中只是淡色）", () => {
		assert.equal(
			markMatches("a-b-a", "a", 1),
			'<mark class="file-find-hit">a</mark>-b-<mark class="file-find-hit file-find-hit-on">a</mark>',
		);
	});

	it("实体还原后再匹配（搜引号能对上高亮里的 &quot;）", () => {
		const marked = markMatches("&quot;name&quot;: 1", '"name"', null);
		assert.equal(marked, '<mark class="file-find-hit">&quot;name&quot;</mark>: 1');
	});

	it("没命中的文本节点一个字符都不动", () => {
		assert.equal(markMatches("<b>abc</b>", "zzz", null), "<b>abc</b>");
	});

	it("跨两个标签的命中不标（已知取舍），但不会把标签弄坏", () => {
		const html = '<span class="a">ab</span><span class="b">cd</span>';
		assert.equal(markMatches(html, "bc", null), html);
	});

	it("空关键字 = 原样返回", () => {
		assert.equal(markMatches("<b>x</b>", "", null), "<b>x</b>");
	});
});

describe("expandFoldsContaining", () => {
	const folds: FoldRange[] = [
		{ start: 0, end: 10 },
		{ start: 2, end: 6 },
		{ start: 8, end: 9 },
	];

	it("把包着这一行的块都展开（外层与内层）", () => {
		const folded = new Set([0, 2, 8]);
		assert.deepEqual(
			[...expandFoldsContaining(folds, folded, 4)].sort((a, b) => a - b),
			[8],
		);
	});

	it("不在任何块里的行：折叠状态不变", () => {
		const folded = new Set([8]);
		assert.deepEqual([...expandFoldsContaining(folds, folded, 20)], [8]);
	});
});

describe("codeSnippet（整块代码进对话）", () => {
	it("先是路径引用，再是带语言的代码块", () => {
		assert.equal(
			codeSnippet("a/b.json", { start: 3, end: 5 }, '  "x": 1,\n  "y": 2', "json"),
			'@a/b.json:3-5\n```json\n  "x": 1,\n  "y": 2\n```',
		);
	});

	it("单行不带区间（走 referenceFor 的既有规矩）", () => {
		assert.equal(
			codeSnippet("a.ts", { start: 7, end: 7 }, "const x = 1;", "typescript"),
			"@a.ts:7\n```typescript\nconst x = 1;\n```",
		);
	});

	it("代码里本身有 ``` 时换成四个反引号，围栏不会被提前关掉", () => {
		const snippet = codeSnippet("r.md", { start: 1, end: 1 }, "```js\nx\n```", "markdown");
		assert.ok(snippet.includes("````markdown"));
		assert.ok(snippet.endsWith("````"));
	});

	it("语言猜不出来时围栏后面留空", () => {
		assert.ok(codeSnippet("a.unknownext", { start: 1, end: 2 }, "x\ny", "").startsWith("@a.unknownext:1-2\n```\n"));
	});
});
