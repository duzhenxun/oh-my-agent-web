/**
 * 面板拖动位置的夹取（`web/src/use-modal-move.ts`）。
 *
 * 两档规矩（这是「不要弹到浏览器外面去」那条要求的分水岭）：
 *   - 严格（`clampModalPos`）：开面板 / 窗口缩放 / 拖角时用 —— 整块留在视口内；
 *   - 宽松（`clampModalPosWhileDragging`）：手指正拖着时用 —— 每个方向至少留 MIN_VISIBLE，
 *     这样「推开来对照着看被挡住的对话」才成立。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MIN_VISIBLE,
	clampModalPos,
	clampModalPosWhileDragging,
	readStoredModalPos,
} from "../../web/src/use-modal-move.ts";

const view = { width: 1280, height: 800 };

describe("clampModalPos（严格：整块留在视口内）", () => {
	it("没位移就还是居中（0,0）", () => {
		assert.deepEqual(clampModalPos({ x: 0, y: 0 }, { width: 600, height: 400 }, view), { x: 0, y: 0 });
	});

	it("往左上推到头：左边缘正好贴住视口左边，不再往外跑", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPos({ x: -99999, y: -99999 }, size, view);
		// 居中时左边缘 (1280-600)/2 = 340 → x 最小 = -340（左边缘刚好到 0）
		assert.equal(far.x, -(view.width - size.width) / 2);
		assert.equal(far.y, -(view.height - size.height) / 2);
	});

	it("往右下推到头：右边缘正好贴住视口右边", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPos({ x: 99999, y: 99999 }, size, view);
		const left = (view.width - size.width) / 2 + far.x;
		const top = (view.height - size.height) / 2 + far.y;
		assert.equal(left + size.width, view.width);
		assert.equal(top + size.height, view.height);
	});

	it("旧数据里存着跑到屏幕外的位置：一打开就被拉回来（用户的截图就是这个）", () => {
		const size = { width: 1000, height: 700 };
		const stale = { x: 900, y: 400 };
		const fixed = clampModalPos(stale, size, view);
		const left = (view.width - size.width) / 2 + fixed.x;
		const top = (view.height - size.height) / 2 + fixed.y;
		assert.ok(left >= 0 && left + size.width <= view.width, "水平方向整块在视口内");
		assert.ok(top >= 0 && top + size.height <= view.height, "垂直方向整块在视口内");
		assert.deepEqual(fixed, {
			x: view.width - size.width - (view.width - size.width) / 2,
			y: view.height - size.height - (view.height - size.height) / 2,
		});
	});

	it("铺满视口的面板严格夹不许动（拖的时候才可以推开）", () => {
		const size = { width: 1280, height: 800 };
		assert.deepEqual(clampModalPos({ x: -400, y: -200 }, size, view), { x: 0, y: 0 });
	});

	it("视口比面板还小时：退化成「至少留 MIN_VISIBLE」，不把面板推到反方向", () => {
		const small = { width: 300, height: 200 };
		const pos = clampModalPos({ x: 50, y: 50 }, { width: 500, height: 400 }, small);
		assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
		// 居中时左边缘 -100 → 50 平移后左边缘 -50，右边缘 450 >  视口 300，但仍留着大块
		assert.equal(pos.x, 50);
	});
});

describe("clampModalPosWhileDragging（宽松：推得开，抓得回）", () => {
	it("面板铺满视口也能推开（这正是需求）", () => {
		const size = { width: 1280, height: 800 };
		assert.deepEqual(clampModalPosWhileDragging({ x: -400, y: -200 }, size, view), { x: -400, y: -200 });
	});

	it("推得再远也会留 MIN_VISIBLE 在视口内", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPosWhileDragging({ x: -99999, y: -99999 }, size, view);
		assert.equal(far.x, MIN_VISIBLE - size.width - (view.width - size.width) / 2);
		assert.equal(far.y, MIN_VISIBLE - size.height - (view.height - size.height) / 2);
		const right = (view.width - size.width) / 2 + far.x + size.width;
		assert.equal(right, MIN_VISIBLE);
	});

	it("右下同样有上限", () => {
		const size = { width: 600, height: 400 };
		const far = clampModalPosWhileDragging({ x: 99999, y: 99999 }, size, view);
		const left = (view.width - size.width) / 2 + far.x;
		assert.equal(left, view.width - MIN_VISIBLE);
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
