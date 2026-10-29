/**
 * 内容搜索浮层的尺寸纯函数（`web/src/content-search-size.ts`）。
 *
 * 钉两件容易写错的事：
 *   - **居中的浮层**拖右下角时宽度要按 `2×dx` 算，否则右边缘追不上指针（会跑掉一半）；
 *   - 尺寸必须夹在 [MIN, 视口] 之内，而且坏记录（手改过的 localStorage）要回默认而不是 NaN。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SEARCH_DEFAULT_WIDTH,
	SEARCH_MIN_HEIGHT,
	SEARCH_MIN_WIDTH,
	clampSearchSize,
	growSearchSize,
	parseStoredSearchSize,
} from "../../web/src/content-search-size.ts";

const VIEW = { width: 1440, height: 900 };

describe("growSearchSize", () => {
	it("居中浮层：宽度按 2× 位移长，右边缘才跟着指针", () => {
		const next = growSearchSize({ w: 900, h: 600 }, 50, 40, VIEW);
		assert.equal(next.w, 1000);
		assert.equal(next.h, 640);
	});

	it("往左上拖会变窄变矮，但不会小过下限", () => {
		assert.deepEqual(growSearchSize({ w: 900, h: 600 }, -10, -10, VIEW), { w: 880, h: 590 });
		const tiny = growSearchSize({ w: 500, h: 300 }, -999, -999, VIEW);
		assert.equal(tiny.w, SEARCH_MIN_WIDTH);
		assert.equal(tiny.h, SEARCH_MIN_HEIGHT);
	});

	it("往右下拖不会超出视口", () => {
		const huge = growSearchSize({ w: 900, h: 600 }, 5000, 5000, VIEW);
		assert.ok(huge.w <= VIEW.width);
		assert.ok(huge.h <= VIEW.height);
	});
});

describe("clampSearchSize", () => {
	it("取整：半像素会让结果列表抖", () => {
		const size = clampSearchSize({ w: 800.6, h: 500.4 }, VIEW);
		assert.equal(size.w, 801);
		assert.equal(size.h, 500);
	});

	it("坏值（NaN）回到可用尺寸而不是 NaN", () => {
		const size = clampSearchSize({ w: Number.NaN, h: Number.NaN }, VIEW);
		assert.ok(Number.isFinite(size.w) && Number.isFinite(size.h));
		assert.equal(size.w, SEARCH_DEFAULT_WIDTH);
	});
});

describe("parseStoredSearchSize", () => {
	it("没有记录 → null（用 CSS 默认尺寸）", () => {
		assert.equal(parseStoredSearchSize(null), null);
	});

	it("正常记录读得回来", () => {
		assert.deepEqual(parseStoredSearchSize(JSON.stringify({ w: 1000, h: 700 })), { w: 1000, h: 700 });
	});

	it("坏记录一律回 null，不抛错", () => {
		assert.equal(parseStoredSearchSize("not json"), null);
		assert.equal(parseStoredSearchSize("{}"), null);
		assert.equal(parseStoredSearchSize(JSON.stringify({ w: 0, h: 700 })), null);
		assert.equal(parseStoredSearchSize(JSON.stringify({ w: "1000", h: null })), null);
	});
});
