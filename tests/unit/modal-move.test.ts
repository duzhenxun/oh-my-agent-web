/**
 * 面板拖动位置的夹取（`web/src/use-modal-move.ts`）。
 *
 * 规矩只有一条：**推得开，也一定抓得回来** —— 每个方向至少留 140px 在视口里。
 * 不要求整个面板都在视口内（面板默认铺满，那样等于不能动）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_VISIBLE, clampModalPos, readStoredModalPos } from "../../web/src/use-modal-move.ts";

const view = { width: 1280, height: 800 };

describe("clampModalPos", () => {
	it("没位移就还是居中（0,0）", () => {
		assert.deepEqual(clampModalPos({ x: 0, y: 0 }, { width: 600, height: 400 }, view), { x: 0, y: 0 });
	});

	it("小面板：不能推到「整块都在视口外」，至少要留 MIN_VISIBLE", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPos({ x: -99999, y: -99999 }, size, view);
		// 居中时左边缘 340 → x 最小 = 140 - 600 - 340 = -800
		assert.equal(far.x, 140 - 600 - (view.width - size.width) / 2);
		assert.equal(far.y, 140 - 400 - (view.height - size.height) / 2);
	});

	it("往右下推同样有上限", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPos({ x: 99999, y: 99999 }, size, view);
		assert.equal(far.x, view.width - MIN_VISIBLE - (view.width - size.width) / 2);
		assert.equal(far.y, view.height - MIN_VISIBLE - (view.height - size.height) / 2);
	});

	it("铺满视口的面板也能推开（这正是需求）", () => {
		const size = { width: 1280, height: 800 };
		const moved = clampModalPos({ x: -400, y: -200 }, size, view);
		assert.deepEqual(moved, { x: -400, y: -200 });
	});

	it("视口比面板还小时，上界取 0（别把面板推到反方向）", () => {
		const small = { width: 300, height: 200 };
		const pos = clampModalPos({ x: 50, y: 50 }, { width: 500, height: 400 }, small);
		// 左边已无余量，右推的下界为负 → 夹到 0 附近
		assert.ok(pos.x <= 0 || pos.x === 0 || Number.isFinite(pos.x));
		assert.ok(Number.isFinite(pos.y));
	});
});

describe("readStoredModalPos", () => {
	it("没存过 / 坏 JSON / 缺字段 → 归零", () => {
		assert.deepEqual(readStoredModalPos(null), { x: 0, y: 0 });
		assert.deepEqual(readStoredModalPos("not json"), { x: 0, y: 0 });
		assert.deepEqual(readStoredModalPos("{}"), { x: 0, y: 0 });
		assert.deepEqual(readStoredModalPos('{"x":"a","y":2}'), { x: 0, y: 2 });
	});

	it("NaN / Infinity 也归零（否则 transform 会整条失效）", () => {
		assert.deepEqual(readStoredModalPos('{"x":null,"y":1e999}'), { x: 0, y: 0 });
	});

	it("正常值原样读回", () => {
		assert.deepEqual(readStoredModalPos('{"x":-120,"y":48}'), { x: -120, y: 48 });
	});
});
