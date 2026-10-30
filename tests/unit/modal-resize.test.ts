/**
 * 大弹窗四角缩放（`web/src/use-modal-size.ts` 的 `resizeFromCorner`）。
 *
 * 用户 2026-10-30：「这个弹窗大小调整让4个边角都可以调」。
 * 四角里最容易写错的是**锚点**：面板在 `.modal-backdrop` 里是 flex 居中的，
 * 宽高一变，两边各让一半 —— 不把一半的变化量补给位置，拖左上角时整个面板会以中心为轴
 * 两边一起长，手感像「拖了一半」。这里用「对面的边/角保持不动」把方向钉死。
 *
 * 第二个坑（用户 2026-10-30 的截图：设置面板一半在屏幕外）：只夹宽高不够。
 * 从右下角往外拖时左边钉住不动，右边界一路长到窗口外面；存进 localStorage 以后，
 * 下次打开就是这个「半个弹窗」。所以算完尺寸还要**把整块夹回视口**。
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

function resize(start: ModalSize, dx: number, dy: number, corner: ModalCorner, pos = { x: 0, y: 0 }) {
	return resizeFromCorner({ start, pos, dx, dy, corner, view });
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

describe("resizeFromCorner：拖角不许把面板推出视口", () => {
	it("面板在右半边时拖 se：右边停在视口右沿，不再长到屏幕外", () => {
		const start: ModalSize = { width: 800, height: 600 };
		// 先把面板推到靠右（左边缘 = (1440-800)/2 + 1080 = 1400 → 右边缘已经在屏外）
		const pos = { x: 1080, y: 0 };
		const { size, shift } = resize(start, 200, 0, "se", pos);
		const after = edges(size, { x: pos.x + shift.x, y: pos.y + shift.y });
		assert.ok(after.right <= view.width, `右边缘 ${after.right} 不该超出视口 ${view.width}`);
		assert.ok(after.left >= 0);
		// 尺寸还是按拖动量长的（不是被压回原值），只是位置被拉回采了
		assert.deepEqual(size, { width: 1000, height: 600 });
	});

	it("面板在左半边时拖 nw：左边停在视口左沿", () => {
		const start: ModalSize = { width: 800, height: 600 };
		const pos = { x: -600, y: 0 };
		const { size, shift } = resize(start, -300, 0, "nw", pos);
		const after = edges(size, { x: pos.x + shift.x, y: pos.y + shift.y });
		assert.ok(after.left >= 0, `左边缘 ${after.left} 不该超出视口左边`);
		assert.ok(after.right <= view.width);
	});

	it("旧数据里那条越界的位置：拖一下就被拉回视口内", () => {
		const start: ModalSize = { width: 900, height: 700 };
		const pos = { x: 1200, y: 600 };
		const { size, shift } = resize(start, 1, 1, "se", pos);
		const after = edges(size, { x: pos.x + shift.x, y: pos.y + shift.y });
		// 容差 1px：居中最是奇数宽时会出 .5，而尺寸与位移都是整数（肉眼无差）
		assert.ok(after.left >= -1 && after.right <= view.width + 1, "水平方向整块在视口内");
		assert.ok(after.top >= -1 && after.bottom <= view.height + 1, "垂直方向整块在视口内");
	});

	it("拖角时「对面的角不动」在没碰到边界之前仍然成立", () => {
		const start: ModalSize = { width: 800, height: 600 };
		const pos = { x: 0, y: 0 };
		const { size, shift } = resize(start, 100, 50, "se", pos);
		const before = edges(start, pos);
		const after = edges(size, { x: pos.x + shift.x, y: pos.y + shift.y });
		assert.equal(after.left, before.left);
		assert.equal(after.top, before.top);
	});
});
