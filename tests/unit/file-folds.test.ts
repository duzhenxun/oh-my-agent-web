/**
 * 源码视图的「一次只展开一层」与右键整块展开 / 收起（`web/src/file-preview.ts`）。
 *
 * 钉四件事：
 *   - `firstLevelFolds`：默认只把**最外层**留着，其余块收起（打开文件先看第一层）；
 *   - `toggleFolded`：展开一块时把它里面的块重新收起（双击 = 再往里看一层）；
 *   - `blockAt`：右键那行的「这一块」= 它所在的最内层块（行本身是块起点就用它）；
 *   - `expandBlock` / `collapseBlock`：整块（含嵌套）全展开 / 全收起，块外的不动；
 *   - `blockFoldState`：这块现在是收着 / 半开 / 全开 —— 右键菜单据它只摆一个动作。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	blockAt,
	blockFoldState,
	collapseBlock,
	computeFolds,
	expandBlock,
	firstLevelFolds,
	toggleFolded,
	type FoldRange,
} from "../../web/src/file-preview.ts";

/** 0-based 行号：
 *  0 `{`  1 `"a": {`  2 `"b": {`  3 `"c": 1`  4 `}`  5 `}`
 *  6 `"d": [`  7 `1,`  8 `2,`  9 `]`  10 `}`
 */
const TEXT = [
	"{",
	'  "a": {',
	'    "b": {',
	'      "c": 1',
	"    }",
	"  },",
	'  "d": [',
	"    1,",
	"    2,",
	"  ]",
	"}",
].join("\n");

const FOLDS: FoldRange[] = [
	{ start: 0, end: 10 }, // 根
	{ start: 1, end: 5 }, // a
	{ start: 2, end: 4 }, // b
	{ start: 6, end: 9 }, // d
];

describe("computeFolds 的前提", () => {
	it("这份样例算出来就是这四块（后面几条都建立在这上面）", () => {
		assert.deepEqual(computeFolds(TEXT), FOLDS);
	});
});

describe("firstLevelFolds", () => {
	it("只留最外层：其余块默认收起", () => {
		assert.deepEqual(firstLevelFolds(FOLDS), [1, 2, 6]);
	});

	it("没有可折叠的块（一行写完的 json）时什么都不收", () => {
		assert.deepEqual(firstLevelFolds([]), []);
	});
});

describe("toggleFolded", () => {
	it("展开一块：它自己打开，里面的块重新收起（一次只多一层）", () => {
		const folded = new Set(firstLevelFolds(FOLDS));
		// 先假设用户之前把 b 也展开过
		folded.delete(2);
		assert.deepEqual(
			[...toggleFolded(FOLDS, folded, 1)].sort((a, b) => a - b),
			[2, 6],
		);
	});

	it("收起一块：只加它自己，里面的状态不动", () => {
		assert.deepEqual([...toggleFolded(FOLDS, new Set(), 1)], [1]);
	});
});

describe("blockAt", () => {
	it("行本身是块起点 → 就是它", () => {
		assert.deepEqual(blockAt(FOLDS, 6), { start: 6, end: 9 });
	});

	it("普通字段行 → 最里面那层包着它的块", () => {
		assert.deepEqual(blockAt(FOLDS, 3), { start: 2, end: 4 });
		assert.deepEqual(blockAt(FOLDS, 7), { start: 6, end: 9 });
	});

	it("根那一行就是根块", () => {
		assert.deepEqual(blockAt(FOLDS, 0), { start: 0, end: 10 });
	});

	it("不在任何块里的行 → null", () => {
		assert.equal(blockAt([{ start: 5, end: 8 }], 2), null);
	});
});

describe("整块展开 / 收起", () => {
	it("展开这一块：连同里面嵌套的一起从折叠集合里拿掉，块外不动", () => {
		const folded = new Set([1, 2, 6, 99]);
		assert.deepEqual(
			[...expandBlock(FOLDS, folded, { start: 1, end: 5 })].sort((a, b) => a - b),
			[6, 99],
		);
	});

	it("收起这一块：连同里面嵌套的一起收起（自己也算）", () => {
		assert.deepEqual(
			[...collapseBlock(FOLDS, new Set(), { start: 1, end: 5 })].sort((a, b) => a - b),
			[1, 2],
		);
	});

	it("收起根 = 整份文件只剩第一行", () => {
		assert.deepEqual(
			[...collapseBlock(FOLDS, new Set(), { start: 0, end: 10 })].sort((a, b) => a - b),
			[0, 1, 2, 6],
		);
	});
});

describe("blockFoldState（右键菜单只摆一个动作）", () => {
	it("这块自己收着 → collapsed", () => {
		assert.equal(blockFoldState(FOLDS, new Set([1]), { start: 1, end: 5 }), "collapsed");
	});

	it("这块开着、里面还有收着的 → partial", () => {
		assert.equal(blockFoldState(FOLDS, new Set([2, 6]), { start: 0, end: 10 }), "partial");
	});

	it("里面也全开着 → open", () => {
		assert.equal(blockFoldState(FOLDS, new Set(), { start: 0, end: 10 }), "open");
	});

	it("块外那些折叠不算数", () => {
		assert.equal(blockFoldState(FOLDS, new Set([6]), { start: 1, end: 5 }), "open");
	});
});
