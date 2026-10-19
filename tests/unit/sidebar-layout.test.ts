/**
 * 侧栏尺寸（纯函数）：拖拽宽度必须夹在区间内，坏值回默认。
 */
import { describe, expect, it } from "vitest";
import {
	clampSidebarWidth,
	readStoredWidth,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "../../web/src/sidebar-layout.ts";

describe("clampSidebarWidth", () => {
	it("区间内原样（取整）", () => {
		expect(clampSidebarWidth(300)).toBe(300);
		expect(clampSidebarWidth(300.4)).toBe(300);
	});

	it("过窄/过宽都夹住", () => {
		expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
		expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
	});

	it("坏值（NaN / Infinity）回默认", () => {
		expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
		expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	it("窗口很窄时 max < min 也不会给出非法值", () => {
		expect(clampSidebarWidth(400, 100)).toBe(SIDEBAR_MIN_WIDTH);
	});
});

describe("readStoredWidth", () => {
	it("没存过 / 坏值都用默认", () => {
		expect(readStoredWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
		expect(readStoredWidth("abc")).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	it("存过的合法值原样读回", () => {
		expect(readStoredWidth("320")).toBe(320);
	});
});
