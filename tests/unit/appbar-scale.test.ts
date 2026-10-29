/**
 * 顶栏缩放系数（`web/src/appbar-scale.ts`）：一个百分比管整条顶栏（高度 + 里面所有元素）。
 *
 * 这里锁四件事：
 *   1. 默认就是「紧凑」85%（用户反馈原来的顶栏太高），100% = 原尺寸；
 *   2. 越界 / 不在刻度上的值都被夹回区间并对齐 5%，不能出现 0%、NaN%、87.0000001；
 *   3. 存的是百分比、写出 CSS 的是无单位系数（`calc(6px * 0.85)` 靠它算）；
 *   4. 只有正好等于某档时才高亮那张快捷卡（`presetOfAppbarScale`）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	APPBAR_SCALE_MAX,
	APPBAR_SCALE_MIN,
	APPBAR_SCALE_PRESETS,
	APPBAR_SCALE_STEP,
	DEFAULT_APPBAR_SCALE,
	appbarScaleCss,
	clampAppbarScale,
	presetOfAppbarScale,
	readStoredAppbarScale,
} from "../../web/src/appbar-scale.ts";

describe("appbar-scale", () => {
	it("默认 85%，且区间两端就是四档里的最小/最大", () => {
		assert.equal(DEFAULT_APPBAR_SCALE, 85);
		assert.equal(readStoredAppbarScale(null), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale(undefined), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale(""), DEFAULT_APPBAR_SCALE);
		assert.equal(APPBAR_SCALE_PRESETS[0].percent, APPBAR_SCALE_MIN);
		assert.equal(APPBAR_SCALE_PRESETS.at(-1)?.percent, 115);
		assert.ok(APPBAR_SCALE_PRESETS.some((item) => item.percent === DEFAULT_APPBAR_SCALE));
	});

	it("坏值 / 越界值都被夹回区间，并对齐 5%", () => {
		// 非有限值走默认（与 `font-scale.clampFontPx` 同一条规矩），不往两端夹
		assert.equal(clampAppbarScale(Number.NaN), DEFAULT_APPBAR_SCALE);
		assert.equal(clampAppbarScale(Number.POSITIVE_INFINITY), DEFAULT_APPBAR_SCALE);
		assert.equal(clampAppbarScale(-40), APPBAR_SCALE_MIN);
		assert.equal(clampAppbarScale(999), APPBAR_SCALE_MAX);
		// 87.0000001（滑杆浮点尾巴）→ 对齐到最近的 5 的倍数
		assert.equal(clampAppbarScale(87.0000001), 85);
		// 88（老存储里不在刻度上的值）→ 90
		assert.equal(clampAppbarScale(88), 90);
		assert.ok(clampAppbarScale(88) % APPBAR_SCALE_STEP === 0);
	});

	it("写进 CSS 的是无单位系数", () => {
		assert.equal(appbarScaleCss(100), "1");
		assert.equal(appbarScaleCss(85), "0.85");
		assert.equal(appbarScaleCss(70), "0.7");
		// 越界也走同一套夹取
		assert.equal(appbarScaleCss(500), String(APPBAR_SCALE_MAX / 100));
	});

	it("存的值：数字照读、档位 id 也认、其它回默认", () => {
		assert.equal(readStoredAppbarScale("70"), 70);
		assert.equal(readStoredAppbarScale("100"), 100);
		assert.equal(readStoredAppbarScale("m"), 85);
		assert.equal(readStoredAppbarScale("xl"), 115);
		assert.equal(readStoredAppbarScale("乱写"), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale("999"), APPBAR_SCALE_MAX);
	});

	it("只有正好落在某一档才高亮那张卡", () => {
		assert.equal(presetOfAppbarScale(85), "m");
		assert.equal(presetOfAppbarScale(100), "l");
		// 90% 在「紧凑」与「标准」之间：一张都不高亮
		assert.equal(presetOfAppbarScale(90), null);
	});
});
