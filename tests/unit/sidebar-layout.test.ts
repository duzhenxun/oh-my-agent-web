/**
 * 侧栏宽度（`web/src/sidebar-layout.ts`）：拖动区间 + **窗口上限**。
 *
 * 这里锁四件事：
 *   1. 宽窗：**没有固定的 520 上限了**（用户 2026-11-04：「最大宽度可以不限制」）——
 *      上限 = `窗口宽 - SIDEBAR_CHAT_RESERVE`（240px，留给对话区与那条拖拽把手）；
 *   2. 窄窗：同一条公式（不再有「窗口 - 430px」那套单独规则）；
 *   3. 任何窗口下都不低于 `SIDEBAR_MIN_WIDTH`（别把侧栏夹成一条缝）；
 *      坏值（NaN / 0 / 负数）→ 上限算「不设」，不抛错。
 *
 * CSS 侧同一个数在 `styles/project-icon.css`（`.side-host` 的 `max-width`）——
 * 改一边必须改另一边，否则会出现「拖到一半不动了」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SIDEBAR_CHAT_RESERVE,
	SIDEBAR_MIN_WIDTH,
	clampSidebarWidth,
	sidebarMaxWidth,
} from "../../web/src/sidebar-layout.ts";

describe("sidebarMaxWidth", () => {
	it("宽窗：上限 = 窗口宽 - 240（没有 520 死上限）", () => {
		assert.equal(sidebarMaxWidth(1440), 1440 - SIDEBAR_CHAT_RESERVE);
		assert.equal(sidebarMaxWidth(1920), 1920 - SIDEBAR_CHAT_RESERVE);
		assert.ok(sidebarMaxWidth(1440) > 520, "以前硬顶 520，现在要能拖得更宽");
	});

	it("窄窗：同一条公式（窗口 - 240，保底 MIN）", () => {
		assert.equal(sidebarMaxWidth(1000), 760);
		assert.equal(sidebarMaxWidth(700), 460);
		assert.equal(sidebarMaxWidth(560), 320);
		assert.equal(sidebarMaxWidth(405), SIDEBAR_MIN_WIDTH); // 405-240 < 240 → 保底
	});

	it("极窄窗：不低于 SIDEBAR_MIN_WIDTH", () => {
		assert.equal(sidebarMaxWidth(320), SIDEBAR_MIN_WIDTH);
		assert.equal(sidebarMaxWidth(100), SIDEBAR_MIN_WIDTH);
	});

	it("坏值：按「不设上限」处理（不抛错）", () => {
		assert.equal(sidebarMaxWidth(Number.NaN), Number.MAX_SAFE_INTEGER);
		assert.equal(sidebarMaxWidth(0), Number.MAX_SAFE_INTEGER);
		assert.equal(sidebarMaxWidth(-100), Number.MAX_SAFE_INTEGER);
		assert.equal(clampSidebarWidth(900, sidebarMaxWidth(Number.NaN)), 900);
	});

	it("配合 clampSidebarWidth：拖不出「显示不出来的宽度」", () => {
		const max = sidebarMaxWidth(1440); // 1200
		assert.equal(clampSidebarWidth(1600, max), 1200);
		assert.equal(clampSidebarWidth(900, max), 900); // 中间值原样保留
		assert.equal(clampSidebarWidth(200, max), SIDEBAR_MIN_WIDTH); // 比下限还窄 → 抬到下限
		// 窄窗：窗口 560 → 上限 320
		assert.equal(clampSidebarWidth(516, sidebarMaxWidth(560)), 320);
	});
});
