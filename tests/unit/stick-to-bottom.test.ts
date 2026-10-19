/**
 * 粘底滚动（纯函数部分）：判断「还贴着底吗」。
 * 阈值内的抖动算粘着（否则流式输出每来一个字符就断开跟随）。
 */
import { describe, expect, it } from "vitest";
import { isNearBottom, STICK_THRESHOLD_PX } from "../../web/src/scroll-math.ts";

describe("isNearBottom", () => {
	it("正好在底部算粘着", () => {
		expect(isNearBottom(1000, 500, 500)).toBe(true);
	});

	it("阈值以内的抖动仍算粘着", () => {
		expect(isNearBottom(1000, 500 - STICK_THRESHOLD_PX + 1, 500)).toBe(true);
	});

	it("往上翻超过阈值就不再跟随（不抢用户滚动）", () => {
		expect(isNearBottom(1000, 300, 500)).toBe(false);
		expect(isNearBottom(2000, 0, 500)).toBe(false);
	});

	it("内容不足一屏时永远算粘着", () => {
		expect(isNearBottom(300, 0, 500)).toBe(true);
	});
});
