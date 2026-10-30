/**
 * 字号（`web/src/font-scale.ts`）：聊天正文 / 侧栏项目名 / 侧栏会话名**各一套**四档，
 * 共用同一个「滑杆 + 快捷档」模型。
 *
 * 这里锁五件事：
 *   1. 每处四档、等距 2px；三处现在同一套刻度 12 / 14 / 16 / 18，「标准」= 默认 14；
 *   2. 老版本存的档位 id（`s/m/l/xl`）按该处刻度换算成像素；
 *   3. 坏值 / 越界值都被夹回 [2, 30] 并对齐 2px，不能出现 0px、NaNpx、12.500001px；
 *   4. 只有正好等于某档时才高亮那张快捷卡（`presetOfPx`）；
 *   5. 老刻度（标准 12 / 13px）的存量像素按档位序号 / 等量平移搬到新刻度。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_FONT_PX,
	FONT_LADDERS,
	FONT_MAX_PX,
	FONT_MIN_PX,
	FONT_STEP_PX,
	clampFontPx,
	findFontScale,
	fontPxCss,
	presetOfPx,
	readStoredFontPx,
	upgradeLegacyFontPx,
	type FontLayer,
} from "../../web/src/font-scale.ts";

const LAYERS: FontLayer[] = ["chat", "project", "session"];

describe("每处一套四档", () => {
	it("四档、等距 2px", () => {
		for (const layer of LAYERS) {
			const sizes = FONT_LADDERS[layer].map((item) => item.px);
			assert.equal(sizes.length, 4, layer);
			assert.deepEqual(sizes, [sizes[0], sizes[0]! + 2, sizes[0]! + 4, sizes[0]! + 6], layer);
		}
	});

	it("「标准」= 该处默认值 = 14px（三处同一套刻度，都是双数）", () => {
		for (const layer of LAYERS) {
			assert.equal(findFontScale("m", layer)?.px, 14, layer);
			assert.equal(DEFAULT_FONT_PX[layer], 14, layer);
			assert.deepEqual(
				FONT_LADDERS[layer].map((item) => item.px),
				[12, 14, 16, 18],
				layer,
			);
		}
	});

	it("最小一档叫「特小」，比标准小 2px", () => {
		for (const layer of LAYERS) {
			const [smallest, standard] = FONT_LADDERS[layer];
			assert.equal(smallest?.label, "特小", layer);
			assert.equal((standard?.px ?? 0) - (smallest?.px ?? 0), 2, layer);
		}
	});
});

describe("容错与映射", () => {
	it("坏值 / 没存过 → 该处默认字号", () => {
		for (const layer of LAYERS) {
			for (const raw of [null, undefined, "", "M", "xxl", "12px"]) {
				assert.equal(readStoredFontPx(raw, layer), DEFAULT_FONT_PX[layer], `${layer}:${raw}`);
			}
		}
	});

	it("新版存像素：对齐到双数后读回来", () => {
		assert.equal(readStoredFontPx("11.5", "chat"), 12); // 11.5 → 最近的偶数
		assert.equal(readStoredFontPx("13", "chat"), 14);
		assert.equal(readStoredFontPx("20", "chat"), 20);
		assert.equal(readStoredFontPx("99", "chat"), FONT_MAX_PX);
	});

	it("老版本存的档位 id：按该处刻度换算", () => {
		for (const layer of LAYERS) {
			for (const item of FONT_LADDERS[layer]) {
				assert.equal(readStoredFontPx(item.id, layer), item.px, `${layer}:${item.id}`);
				assert.equal(findFontScale(item.id, layer)?.id, item.id, `${layer}:${item.id}`);
			}
		}
	});

	it("fontPxCss 对 NaN / 越界都给出合法值（CSS 变量不能是空串或 NaNpx）", () => {
		assert.equal(fontPxCss(Number.NaN), `${DEFAULT_FONT_PX.chat}px`);
		assert.equal(fontPxCss(1), `${FONT_MIN_PX}px`);
		assert.equal(fontPxCss(99), `${FONT_MAX_PX}px`);
		assert.equal(findFontScale("nope", "chat"), null);
	});
});

describe("夹区间 + 2px 步长", () => {
	it("越界夹回 [2, 30]", () => {
		assert.equal(clampFontPx(0.5), FONT_MIN_PX);
		assert.equal(clampFontPx(40), FONT_MAX_PX);
		assert.equal(clampFontPx(20), 20);
	});

	it("奇数 / 浮点尾巴对齐到最近的偶数（滑杆会给出 13、12.0000001 这种数）", () => {
		assert.equal(clampFontPx(13), 14);
		assert.equal(clampFontPx(11), 12);
		assert.equal(clampFontPx(12.0000001), 12);
		assert.ok(clampFontPx(17) % FONT_STEP_PX === 0);
	});

	it("NaN / Infinity → 该处默认值", () => {
		assert.equal(clampFontPx(Number.NaN, "project"), 14);
		assert.equal(clampFontPx(Number.POSITIVE_INFINITY, "session"), 14);
	});
});

describe("快捷档高亮", () => {
	it("正好等于某档才高亮（档位之外不高亮任何一张）", () => {
		for (const layer of LAYERS) {
			for (const item of FONT_LADDERS[layer]) assert.equal(presetOfPx(item.px, layer), item.id, layer);
			// 步长 2 = 四档之间没有落得下的偶数，所以「档位之间」只能是超出四档的值
			assert.equal(presetOfPx(20, layer), null, layer);
			assert.equal(presetOfPx(30, layer), null, layer);
		}
	});
});

describe("老刻度迁移（标准从 12 / 13 抬到 14）", () => {
	it("正好在老档位上：按档位序号搬到新档位（相对选择不变）", () => {
		// 聊天老刻度 10 / 12 / 14 / 16 → 新 12 / 14 / 16 / 18
		assert.deepEqual(
			[10, 12, 14, 16].map((px) => upgradeLegacyFontPx(px, "chat")),
			[12, 14, 16, 18],
		);
		// 项目名老刻度 11 / 13 / 15 / 17 → 同样落到新四档
		assert.deepEqual(
			[11, 13, 15, 17].map((px) => upgradeLegacyFontPx(px, "project")),
			[12, 14, 16, 18],
		);
	});

	it("拖出来的奇数值：按两层标准的差等量平移，结果仍是双数", () => {
		assert.equal(upgradeLegacyFontPx(20, "chat"), 22); // +2
		assert.equal(upgradeLegacyFontPx(9, "chat"), 12); // 9+2=11 → 对到 12
		assert.ok(upgradeLegacyFontPx(15, "project") % FONT_STEP_PX === 0);
	});

	it("坏值 → 该处默认值（不抛错）", () => {
		assert.equal(upgradeLegacyFontPx(Number.NaN, "chat"), 14);
	});
});
