/**
 * 图片显示宽度 = min(逻辑尺寸, 用户设的上限, **实测列宽**)。（用户 2026-11-02：「有图片时会出现
 * 左右滚动，手机版会漂」。）
 *
 * 前两道上限都是绝对值（Retina 折回 / 设置里填的 400px），手机正文列只有 330 上下，于是
 * 图片比气泡宽、整页能左右拖。第三条是运行时量出来的列宽：宽度由内容决定的容器里，百分比是
 * 循环依赖（各引擎处理不一致），算成像素值才谁也绕不过去。样式表那边的两道见
 * `tests/unit/mobile-overflow-css.test.ts`（`min(var(--md-img-cap), 100%)`）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageMaxWidthOf } from "../../web/src/image-display.ts";

describe("imageMaxWidthOf：三条上限取最小", () => {
	// 2x 的 Retina 截图：1290 物理像素 = 645 逻辑点
	const retina = { naturalWidth: 1290, dpr: 2, src: "/api/uploads/x", cap: 400 };

	it("桌面：逻辑宽度与用户上限之间取小的那个", () => {
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: 900 }), 400);
	});

	it("手机：列宽比用户上限还窄时，按列宽收（这条是本次 bug 的正面用例）", () => {
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: 330 }), 330);
	});

	it("列宽更宽时不影响原来的上限（不会因为量到 1200 就把图放大）", () => {
		assert.equal(imageMaxWidthOf({ ...retina, cap: null, availableWidth: 1200 }), 645);
	});

	it("小图不被拉大：上限只用来收，不当尺寸用", () => {
		assert.equal(imageMaxWidthOf({ naturalWidth: 120, dpr: 2, src: "/n/abc", cap: 400, availableWidth: 330 }), 60);
	});

	it("量不到列宽（面板关着 / 还没布局）时退回原来的两道上限", () => {
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: null }), 400);
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: 0 }), 400);
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: Number.NaN }), 400);
	});

	it("站外图不按 dpr 折（不知道是按几倍存的），但仍然受列宽约束", () => {
		const remote = { naturalWidth: 800, dpr: 2, src: "https://example.com/a.png", cap: 400 };
		assert.equal(imageMaxWidthOf({ ...remote, availableWidth: 1200 }), 400);
		assert.equal(imageMaxWidthOf({ ...remote, availableWidth: 330 }), 330);
	});

	it("上限设成 0 / 负数 = 不设上限，只剩列宽这一道", () => {
		assert.equal(imageMaxWidthOf({ ...retina, cap: 0, availableWidth: 330 }), 330);
		assert.equal(imageMaxWidthOf({ ...retina, cap: -5, availableWidth: null }), 645);
	});

	it("列宽有小数时向下取整（宁可少 1px，也不要因为 x.5 撑出滚动条）", () => {
		assert.equal(imageMaxWidthOf({ ...retina, availableWidth: 330.7 }), 330);
	});
});
