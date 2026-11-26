/**
 * 朗读小宠物的**吸边几何**（`web/src/components/SpeechPet.tsx` 的 `settlePlace`）。
 *
 * 用户 2026-11-24：「拖到边缘自动吸边，松手时如果贴着屏幕边就自动吸附成一个小半圆」。
 *
 * 这里钉三件事，都是「差几个像素就会看着别扭」的地方：
 *   1. 离边不到 `SNAP`（28px）才吸，远了不吸；
 *   2. 吸上之后坐标**顶到边上**（left 边 x=0、right 边 x=视口宽-宠物宽），
 *      这样半圆的平边正好贴着屏幕边，而不是留一条缝；
 *   3. 离四条边都远时只做「夹回视口」，不改吸附状态。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settlePlace } from "../../web/src/components/SpeechPet.tsx";

const VIEWPORT = { width: 1000, height: 800 };
/** 宠物本体 46×46（和 CSS 一致） */
const PET = { width: 46, height: 46 };

describe("宠物吸边", () => {
	it("贴右边（距边 10px）→ 吸到右边，x 顶到 视口宽-宠物宽", () => {
		const place = settlePlace({ x: 944, y: 300 }, PET, VIEWPORT);
		assert.equal(place.docked, "right");
		assert.equal(place.x, VIEWPORT.width - PET.width); // 954
		assert.equal(place.y, 300, "另一条轴不该动");
	});

	it("贴左边（距边 5px）→ 吸到左边，x = 0", () => {
		const place = settlePlace({ x: 5, y: 300 }, PET, VIEWPORT);
		assert.equal(place.docked, "left");
		assert.equal(place.x, 0);
	});

	it("贴上边（距边 6px）→ 吸到上边，y = 0", () => {
		const place = settlePlace({ x: 400, y: 6 }, PET, VIEWPORT);
		assert.equal(place.docked, "top");
		assert.equal(place.y, 0);
		assert.equal(place.x, 400);
	});

	it("贴下边（距边 4px）→ 吸到下边，y = 视口高-宠物高", () => {
		const place = settlePlace({ x: 400, y: VIEWPORT.height - PET.height - 4 }, PET, VIEWPORT);
		assert.equal(place.docked, "bottom");
		assert.equal(place.y, VIEWPORT.height - PET.height);
	});

	it("离边都远（中间）→ 不吸，位置原样", () => {
		const place = settlePlace({ x: 400, y: 300 }, PET, VIEWPORT);
		assert.equal(place.docked, null);
		assert.deepEqual({ x: place.x, y: place.y }, { x: 400, y: 300 });
	});

	it("刚好卡在阈值上不算吸（>= 28px）", () => {
		// 距右边正好 28px：x = 1000 - 46 - 28 = 926
		assert.equal(settlePlace({ x: 926, y: 300 }, PET, VIEWPORT).docked, null);
		// 再靠近 1px 就吸
		assert.equal(settlePlace({ x: 927, y: 300 }, PET, VIEWPORT).docked, "right");
	});

	it("拖出视口外（负数 / 过大）→ 先夹回来再判断", () => {
		const left = settlePlace({ x: -200, y: 300 }, PET, VIEWPORT);
		assert.equal(left.docked, "left");
		assert.equal(left.x, 0);

		const far = settlePlace({ x: 5000, y: 300 }, PET, VIEWPORT);
		assert.equal(far.docked, "right");
		assert.equal(far.x, VIEWPORT.width - PET.width);
	});
});
