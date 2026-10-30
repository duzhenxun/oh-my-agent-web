/**
 * 大弹窗四角缩放（`web/src/use-modal-size.ts` 的 `resizeFromCorner`）。
 *
 * 用户 2026-10-30：「这个弹窗大小调整让4个边角都可以调」。
 * 四角里最容易写错的是**锚点**：面板在 `.modal-backdrop` 里是 flex 居中的，
 * 宽高一变，两边各让一半 —— 不把一半的变化量补给位置，拖左上角时整个面板会以中心为轴
 * 两边一起长，手感像「拖了一半」。这里用「对面的边/角保持不动」把方向钉死。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resizeFromCorner, type ModalCorner, type ModalSize, type Viewport } from "../../web/src/use-modal-size.ts";

const view: Viewport = { width: 1440, height: 900 };

/** 居中布局下四个边/角的位置（与 CSS `align-items: center` 同口径） */
function edges(size: ModalSize, shift: { x: number; y: number }) {
	const left = (view.width - size.width) / 2 + shift.x;
	const top = (view.height - size.height) / 2 + shift.y;
	return { left, top, right: left + size.width, bottom: top + size.height };
}

function resize(start: ModalSize, dx: number, dy: number, corner: ModalCorner) {
	return resizeFromCorner({ start, dx, dy, corner, view });
}

describe("resizeFromCorner：四个角的方向", () => {
	const start: ModalSize = { width: 800, height: 600 };
	const before = edges(start, { x: 0, y: 0 });

	it("se（右下）：往右下变大，左上角不动", () => {
		const { size, shift } = resize(start, 100, 50, "se");
		assert.deepEqual(size, { width: 900, height: 650 });
		assert.deepEqual(shift, { x: 50, y: 25 });
		const after = edges(size, shift);
		assert.equal(after.left, before.left);
		assert.equal(after.top, before.top);
	});

	it("nw（左上）：往右下拖变小，右下角不动；左边/上边跟着鼠标走满全程", () => {
		const { size, shift } = resize(start, 100, 50, "nw");
		assert.deepEqual(size, { width: 700, height: 550 });
		assert.deepEqual(shift, { x: 50, y: 25 });
		const after = edges(size, shift);
		assert.equal(after.right, before.right);
		assert.equal(after.bottom, before.bottom);
		assert.equal(after.left, before.left + 100);
		assert.equal(after.top, before.top + 50);
	});

	it("ne（右上）：往右变大、往下变小，左下角不动", () => {
		const { size, shift } = resize(start, 100, 50, "ne");
		assert.deepEqual(size, { width: 900, height: 550 });
		assert.deepEqual(shift, { x: 50, y: 25 });
		const after = edges(size, shift);
		assert.equal(after.left, before.left);
		assert.equal(after.bottom, before.bottom);
		assert.equal(after.right, before.right + 100);
		assert.equal(after.top, before.top + 50);
	});

	it("sw（左下）：往右变小、往下变大，右上角不动", () => {
		const { size, shift } = resize(start, 100, 50, "sw");
		assert.deepEqual(size, { width: 700, height: 650 });
		assert.deepEqual(shift, { x: 50, y: 25 });
		const after = edges(size, shift);
		assert.equal(after.right, before.right);
		assert.equal(after.top, before.top);
		assert.equal(after.left, before.left + 100);
		assert.equal(after.bottom, before.bottom + 50);
	});
});

describe("resizeFromCorner：夹取之后再算位移", () => {
	it("拖到最小尺寸：尺寸停在 620×340，位置也不再跑", () => {
		const atMin: ModalSize = { width: 620, height: 340 };
		const { size, shift } = resize(atMin, 100, 100, "nw");
		assert.deepEqual(size, atMin);
		assert.deepEqual(shift, { x: 0, y: 0 });
	});

	it("拖到最大尺寸：停在该视口允许的最大值（视口减两圈 gap），位置不动", () => {
		const atMax: ModalSize = { width: view.width - 32, height: view.height - 32 };
		const { size, shift } = resize(atMax, 100, 100, "se");
		assert.deepEqual(size, atMax);
		assert.deepEqual(shift, { x: 0, y: 0 });
	});

	it("从最小尺寸往外拖：尺寸按真实拖动量长回来（不是从夹取值开始算）", () => {
		const atMin: ModalSize = { width: 620, height: 340 };
		const { size, shift } = resize(atMin, 200, 120, "se");
		assert.deepEqual(size, { width: 820, height: 460 });
		assert.deepEqual(shift, { x: 100, y: 60 });
	});
});
