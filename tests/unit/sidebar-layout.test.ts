/**
 * 侧栏宽度（`web/src/sidebar-layout.ts`）：拖动区间 + **窄窗下的实际上限**。
 *
 * 这里锁四件事：
 *   1. 宽窗：上限还是 `SIDEBAR_MAX_WIDTH`（520），跟以前一样；
 *   2. 窄窗（≤1000px）：上限 = `窗口宽 - 430px`（右边要留给会话标题 + 那排面板入口）——
 *      因为顶栏左段与侧栏等宽，侧栏一宽，顶栏中间的标题就被挤没、入口被挤出窗口
 *      （用户报的那个现象）；
 *   3. 任何窗口下都不低于 `SIDEBAR_MIN_WIDTH`（别把侧栏夹成一条缝）；
 *      坏值（NaN / 0 / 负数）退回宽窗行为，不抛错。
 *
 * CSS 侧同一个数在 `styles/responsive.css`（`@media (min-width: 401px) and (max-width: 1000px)`
 * 里的 `max(240px, calc(100vw - 430px))`）—— 改一边必须改另一边，
 * 否则两处宽度不一致，顶栏那道分段线就会跟侧栏边框错开。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	clampSidebarWidth,
	sidebarMaxWidth,
} from "../../web/src/sidebar-layout.ts";

describe("sidebarMaxWidth", () => {
	it("宽窗（>1000px）：上限就是 SIDEBAR_MAX_WIDTH", () => {
		assert.equal(sidebarMaxWidth(1440), SIDEBAR_MAX_WIDTH);
		assert.equal(sidebarMaxWidth(1001), SIDEBAR_MAX_WIDTH);
	});

	it("窄窗：上限 = 窗口宽 - 430px（留给标题 + 入口排）", () => {
		assert.equal(sidebarMaxWidth(560), 240); // 560-430=130 → 保底 SIDEBAR_MIN_WIDTH
		assert.equal(sidebarMaxWidth(700), 270); // 700-430
		assert.equal(sidebarMaxWidth(1000), 570); // 1000-430（再由 SIDEBAR_MAX_WIDTH 的上层负责）
	});

	it("极窄窗：不低于 SIDEBAR_MIN_WIDTH", () => {
		assert.equal(sidebarMaxWidth(320), SIDEBAR_MIN_WIDTH);
		assert.equal(sidebarMaxWidth(100), SIDEBAR_MIN_WIDTH);
	});

	it("坏值：退回宽窗行为（不抛错）", () => {
		assert.equal(sidebarMaxWidth(Number.NaN), SIDEBAR_MAX_WIDTH);
		assert.equal(sidebarMaxWidth(0), SIDEBAR_MAX_WIDTH);
		assert.equal(sidebarMaxWidth(-100), SIDEBAR_MAX_WIDTH);
	});

	it("配合 clampSidebarWidth：窄窗里拖不出「显示不出来的宽度」", () => {
		const max = sidebarMaxWidth(700); // 270
		assert.equal(clampSidebarWidth(516, max), 270);
		assert.equal(clampSidebarWidth(200, max), SIDEBAR_MIN_WIDTH); // 比下限还窄 → 抬到下限
		// 窄到「窗口宽 - 430」低于最小宽度时，仍保底给 MIN（不是 0）
		const tiny = sidebarMaxWidth(405); // 405-430 < 0 → 240
		assert.equal(tiny, SIDEBAR_MIN_WIDTH);
		assert.equal(clampSidebarWidth(400, tiny), SIDEBAR_MIN_WIDTH);
	});
});
