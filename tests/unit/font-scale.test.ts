/**
 * 字号（`web/src/font-scale.ts`）：聊天正文 / 侧栏项目名 / 侧栏会话名**各一套**四档，
 * 共用同一个"滑杆 + 快捷档"模型。
 *
 * 这里锁五件事：
 *   1. 每处四档、等距 2px；「标准」= 该处默认值（聊天 12 / 项目名 13 / 会话名 12）；
 *   2. 老版本存的档位 id（`s/m/l/xl`）按**该处**刻度换算 —— 所以 `"m"` 在项目名那里是 13；
 *   3. 坏值 / 越界值都被夹回区间并对齐 0.5px，不能出现 0px、NaNpx、12.500001px；
 *   4. 只有正好等于某档时才高亮那张快捷卡（`presetOfPx`）；
 *   5. 老键（`agent-web.chat-font` 存 "m" 之类）升级后仍读得出来。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_FONT_PX,
	DEFAULT_FONT_SCALE,
	FONT_LADDERS,
	FONT_MAX_PX,
	FONT_MIN_PX,
	clampFontPx,
	findFontScale,
	fontPxCss,
	presetOfPx,
	readStoredFontPx,
	readStoredFontScale,
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

	it("「标准」= 该处默认值：聊天 12 / 项目名 13 / 会话名 12", () => {
		assert.deepEqual(
			{
				chat: FONT_LADDERS.chat.find((item) => item.id === "m")?.px,
				project: FONT_LADDERS.project.find((item) => item.id === "m")?.px,
				session: FONT_LADDERS.session.find((item) => item.id === "m")?.px,
			},
			{ chat: 12, project: 13, session: 12 },
		);
		assert.deepEqual(DEFAULT_FONT_PX, { chat: 12, project: 13, session: 12 });
		assert.equal(DEFAULT_FONT_SCALE, "m");
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

	it("新版存像素：原样读回来（含档位之间的连续值）", () => {
		assert.equal(readStoredFontPx("11.5", "chat"), 11.5);
		assert.equal(readStoredFontPx("13", "chat"), 13);
		assert.equal(readStoredFontPx("20", "chat"), FONT_MAX_PX);
	});

	it("老版本存的档位 id：按该处刻度换算", () => {
		assert.equal(readStoredFontPx("m", "chat"), 12);
		assert.equal(readStoredFontPx("m", "project"), 13); // 同一句 "m"，项目名那里是 13
		assert.equal(readStoredFontPx("m", "session"), 12);
		for (const layer of LAYERS) {
			for (const item of FONT_LADDERS[layer]) {
				assert.equal(readStoredFontPx(item.id, layer), item.px);
				assert.equal(readStoredFontScale(item.id, layer), item.id);
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

describe("夹区间 + 0.5 步长", () => {
	it("越界夹回 [2, 20]", () => {
		assert.equal(clampFontPx(0.5), FONT_MIN_PX);
		assert.equal(clampFontPx(40), FONT_MAX_PX);
		assert.equal(clampFontPx(5), 5); // 区间内的小字号照原样
	});

	it("浮点尾巴对齐到 0.5（滑杆会给出 12.500000001 这种数）", () => {
		assert.equal(clampFontPx(12.500000001), 12.5);
		assert.equal(clampFontPx(12.74), 12.5);
		assert.equal(clampFontPx(12.76), 13);
	});

	it("NaN / Infinity → 该处默认值", () => {
		assert.equal(clampFontPx(Number.NaN, "project"), 13);
		assert.equal(clampFontPx(Number.POSITIVE_INFINITY, "session"), 12);
	});
});

describe("快捷档高亮", () => {
	it("正好等于某档才高亮（档位之间不高亮任何一张）", () => {
		for (const layer of LAYERS) {
			for (const item of FONT_LADDERS[layer]) assert.equal(presetOfPx(item.px, layer), item.id, layer);
			assert.equal(presetOfPx(12.5, layer), null, layer);
		}
	});

	it("同一像素在不同层的高亮互不影响", () => {
		assert.equal(presetOfPx(13, "project"), "m");
		assert.equal(presetOfPx(13, "chat"), null); // 聊天那里的 13 落在档位之间
	});
});
