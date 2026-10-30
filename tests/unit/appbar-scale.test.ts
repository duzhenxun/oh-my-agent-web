/**
 * 顶栏缩放系数（`web/src/appbar-scale.ts`）：一个百分比管整条顶栏（高度 + 里面所有元素）。
 *
 * 这里锁五件事：
 *   1. 默认 = 「标准」100%（2026-10-29 刻度重定基准：100% 乘 1.15 才是 CSS 倍数）；
 *   2. 越界 / 不在刻度上的值都被夹回 [60,120] 并对齐 5%，不能出现 0%、NaN%；
 *   3. 写进 CSS 的是无单位倍数（`calc(6px * 1.15)` 靠它算）；
 *   4. 存的是百分比，手改的档位 id（"m"）也认，其它回默认；
 *   5. 旧刻度（100 = CSS 原值）存的值按 /1.15 折算 —— 用户看到的尺寸不能因为改名而变。
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
	migrateLegacyAppbarScale,
	presetOfAppbarScale,
	readStoredAppbarScale,
} from "../../web/src/appbar-scale.ts";

describe("appbar-scale", () => {
	it("默认 100%（= 「标准」档），且区间两端就是四档里的最小/最大", () => {
		assert.equal(DEFAULT_APPBAR_SCALE, 100);
		assert.equal(readStoredAppbarScale(null), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale(undefined), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale(""), DEFAULT_APPBAR_SCALE);
		assert.equal(APPBAR_SCALE_PRESETS[0]?.percent, APPBAR_SCALE_MIN);
		assert.equal(APPBAR_SCALE_PRESETS.at(-1)?.percent, APPBAR_SCALE_MAX);
		assert.deepEqual(
			APPBAR_SCALE_PRESETS.map((item) => item.percent),
			[60, 75, 100, 120],
		);
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

	it("写进 CSS 的是无单位倍数（100% × 1.15）", () => {
		assert.equal(appbarScaleCss(100), "1.15");
		assert.equal(appbarScaleCss(60), "0.69");
		assert.equal(appbarScaleCss(75), "0.8625");
		assert.equal(appbarScaleCss(120), "1.38");
		// 越界也走同一套夹取
		assert.equal(appbarScaleCss(500), "1.38");
	});

	it("存的值：数字照读、档位 id 也认、其它回默认", () => {
		assert.equal(readStoredAppbarScale("70"), 70);
		assert.equal(readStoredAppbarScale("100"), 100);
		assert.equal(readStoredAppbarScale("m"), 75);
		assert.equal(readStoredAppbarScale("xl"), 120);
		assert.equal(readStoredAppbarScale("乱写"), DEFAULT_APPBAR_SCALE);
		assert.equal(readStoredAppbarScale("999"), APPBAR_SCALE_MAX);
	});

	it("旧刻度（100 = CSS 原值）折算成新刻度：物理大小不动", () => {
		assert.equal(migrateLegacyAppbarScale("115"), 100); // 旧「标准」→ 新「标准」
		assert.equal(migrateLegacyAppbarScale("85"), 75); // 85 / 1.15 = 73.9 → 75
		assert.equal(migrateLegacyAppbarScale("70"), 60); // 70 / 1.15 = 60.9 → 60
		assert.equal(migrateLegacyAppbarScale("140"), 120); // 越界夹回上限
		assert.equal(migrateLegacyAppbarScale("m"), 75); // 旧档位 id 按旧表换算
		assert.equal(migrateLegacyAppbarScale("乱写"), 85); // 认不出来当旧刻度 100% → 86.9 → 85
	});

	it("只有正好落在某一档才高亮那张卡", () => {
		assert.equal(presetOfAppbarScale(75), "m");
		assert.equal(presetOfAppbarScale(100), "l");
		// 90% 在「紧凑」与「标准」之间：一张都不高亮
		assert.equal(presetOfAppbarScale(90), null);
	});
});
