/**
 * 图片预览浮层的纯逻辑（`web/src/image-viewer.ts`）：缩放档位与下载文件名。
 *
 * 这两件事最容易出「看着能用、边界就崩」的问题：
 *  - 缩放：坏值（NaN / 0 / 负数）必须回落到 1，且顶到上下限就停住；
 *  - 文件名：alt 往往是「截图 2024-01-02 10.00.00.png」这种带空格的名字，
 *    也可能整个是空的、或者只剩 `/api/uploads/<uuid>`（没有扩展名）——
 *    存下来的文件得能双击打开，所以**优先挑带扩展名的那个**，并洗掉非法字符。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampZoom,
	downloadNameOf,
	fitScaleOf,
	zoomBy,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
} from "../../web/src/image-viewer.ts";

describe("图片预览缩放", () => {
	it("放大/缩小走同一个步进，且顶到上下限就不动", () => {
		assert.equal(zoomBy(1, "in"), ZOOM_STEP);
		assert.equal(zoomBy(1, "out"), 1 / ZOOM_STEP);
		// 逼近上限：不会越过，也不会因为浮点变成 Infinity
		assert.equal(zoomBy(ZOOM_MAX, "in"), ZOOM_MAX);
		assert.equal(zoomBy(ZOOM_MIN, "out"), ZOOM_MIN);
	});

	it("坏值一律当 1：NaN / 0 / 负数不会把图缩没", () => {
		assert.equal(clampZoom(Number.NaN), 1);
		assert.equal(clampZoom(0), 1);
		assert.equal(clampZoom(-3), 1);
		assert.equal(zoomBy(Number.NaN, "in"), ZOOM_STEP);
		assert.equal(zoomBy(0, "out"), 1 / ZOOM_STEP);
	});

	it("适应窗口：大图缩到视口内，小图保持原始尺寸（不放大）", () => {
		const viewport = { width: 1000, height: 800 };
		// 4000x2000 的截图：受宽度约束 → 1000*0.94/4000
		assert.equal(fitScaleOf({ width: 4000, height: 2000 }, viewport), 0.235);
		// 小图：不放大
		assert.equal(fitScaleOf({ width: 200, height: 100 }, viewport), 1);
		// 尺寸缺失：安全回落
		assert.equal(fitScaleOf({ width: 0, height: 0 }, viewport), 1);
	});
});

describe("图片预览下载文件名", () => {
	it("优先用上传时的原始名（带扩展名）", () => {
		assert.equal(
			downloadNameOf("/api/uploads/abc-123", "截图 2024-01-02 10.00.00.png"),
			"截图 2024-01-02 10.00.00.png",
		);
	});

	it("alt 没扩展名时，退回服务端路径里的文件名", () => {
		assert.equal(downloadNameOf("/api/files/raw?path=%2Ftmp%2Fshot.jpg", "shot"), "shot.jpg");
	});

	it("上传图只剩 uuid：URL 自身没有扩展名就用它，不至于取不到名字", () => {
		assert.equal(downloadNameOf("/api/uploads/abc-123"), "abc-123");
	});

	it("洗掉非法字符并限制长度", () => {
		assert.equal(downloadNameOf("https://example.com/a/b%3Ac*.png?x=1"), "b_c_.png");
		assert.equal(downloadNameOf("/x/", ""), "image");
		assert.equal(downloadNameOf("", ""), "image");
	});

	it("坏的 % 转义不会抛", () => {
		assert.equal(downloadNameOf("/api/files/raw?path=%E0%A4%A.png"), "%E0%A4%A.png");
	});
});
