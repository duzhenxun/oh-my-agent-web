/**
 * 侧栏会话多选（`web/src/session-selection.ts`）。
 *
 * 用户 2026-10-29：「按 Shift 点选一批，或者 Ctrl 加点几个，然后右键批量删除 / 批量归档」。
 * 选中态本身在 Sidebar 里（它才知道整条列表的可见顺序），但**范围怎么算**在这里钉死：
 * 往上连选、锚点被删掉、锚点看不见了 —— 这三种是这种交互最容易出洋相的地方。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneSelection, rangeSelection, toggleSelection } from "../../web/src/session-selection.ts";

const ORDER = ["a", "b", "c", "d", "e"];

describe("rangeSelection（Shift 连选）", () => {
	it("向下连选：含两端", () => {
		assert.deepEqual(rangeSelection(ORDER, "b", "d"), ["b", "c", "d"]);
	});

	it("向上连选（从下往上 Shift 也要能用）", () => {
		assert.deepEqual(rangeSelection(ORDER, "d", "b"), ["b", "c", "d"]);
	});

	it("点到锚点自己 = 只选这一条", () => {
		assert.deepEqual(rangeSelection(ORDER, "c", "c"), ["c"]);
	});

	it("没有锚点（一上来就按住 Shift）= 只选目标，不抛错也不全选", () => {
		assert.deepEqual(rangeSelection(ORDER, null, "c"), ["c"]);
	});

	it("锚点已经不在可见列表里（被归档 / 项目被折叠）= 退化成只选目标", () => {
		assert.deepEqual(rangeSelection(ORDER, "zzz", "c"), ["c"]);
	});

	it("目标不在列表里（理论上的越界）= 也只返回它自己，不静默选一片", () => {
		assert.deepEqual(rangeSelection(ORDER, "a", "zzz"), ["zzz"]);
	});

	it("锚点在第一行、目标在最后一行 = 全选", () => {
		assert.deepEqual(rangeSelection(ORDER, "a", "e"), ORDER);
	});
});

describe("toggleSelection（Ctrl/⌘ 加减选）", () => {
	it("加选：接到末尾（末尾 = 后点的，Shift 的锚点取它）", () => {
		assert.deepEqual(toggleSelection(["a"], "c"), ["a", "c"]);
	});

	it("减选：把这一条摘掉，其余顺序不变", () => {
		assert.deepEqual(toggleSelection(["a", "c", "e"], "c"), ["a", "e"]);
	});

	it("空选区加一条 = 只有它", () => {
		assert.deepEqual(toggleSelection([], "b"), ["b"]);
	});

	it("不修改传入的数组（React 状态不能就地改）", () => {
		const before = ["a", "b"];
		toggleSelection(before, "c");
		assert.deepEqual(before, ["a", "b"]);
	});
});

describe("pruneSelection（剔掉看不见的选中项）", () => {
	it("被删 / 被归档的那些自动退出选区", () => {
		assert.deepEqual(pruneSelection(["a", "b", "c"], ["b", "c", "d"]), ["b", "c"]);
	});

	it("全都看不见了 = 空选区（批量菜单就不该再弹出来）", () => {
		assert.deepEqual(pruneSelection(["a", "b"], []), []);
	});

	it("没变化时原样返回内容（调用方靠长度判断要不要 setState）", () => {
		assert.deepEqual(pruneSelection(["a"], ["a", "b"]), ["a"]);
	});
});
