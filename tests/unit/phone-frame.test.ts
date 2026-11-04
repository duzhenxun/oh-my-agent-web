/**
 * 手机尺寸预览（`web/src/phone-frame.ts`）：机型表 + 自适应缩放。
 *
 * 这里锁三件事：
 *   1. 存过什么 id 就用哪台；存了个不认识的（手改 localStorage / 机型被删）退回默认，不抛错；
 *   2. 缩放**永远不放大**（面板比手机还宽时，手机就该是手机那么大，放大反而看不准）；
 *   3. 面板窄/矮时按小的那一维缩，并且留出机身与边缘之间的空隙。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitScale, PHONE_PRESET_DEFAULT, PHONE_PRESETS, phonePresetOf } from "../../web/src/phone-frame.ts";

describe("手机尺寸预览", () => {
	it("机型 id 唯一，且默认那台在表里", () => {
		const ids = PHONE_PRESETS.map((preset) => preset.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.includes(PHONE_PRESET_DEFAULT));
		// 每一台都得是像样的手机 / 平板尺寸：宽度落在 320–1024 之间
		for (const preset of PHONE_PRESETS) {
			assert.ok(preset.width >= 320 && preset.width <= 1024, preset.id);
			assert.ok(preset.height > preset.width, `${preset.id} 是竖屏，高必须大于宽`);
		}
	});

	it("按 id 取机型；不认识就退回默认", () => {
		assert.equal(phonePresetOf("se").width, 375);
		assert.equal(phonePresetOf(null).id, PHONE_PRESET_DEFAULT);
		assert.equal(phonePresetOf("").id, PHONE_PRESET_DEFAULT);
		assert.equal(phonePresetOf("nokia-3310").id, PHONE_PRESET_DEFAULT);
	});

	it("放得下就 1：1，绝不放大", () => {
		const preset = phonePresetOf("se");
		assert.equal(fitScale({ width: 1200, height: 900 }, preset), 1);
		assert.equal(fitScale({ width: 375 + 24, height: 667 + 24 }, preset), 1);
	});

	it("放不下时按更紧的那一维缩，并扣掉两边留白", () => {
		const preset = phonePresetOf("se");
		// 宽度紧：可用 399 = 375 + 24 → 正好 1
		assert.equal(fitScale({ width: 398, height: 900 }, preset), 1);
		// 宽度 300 → (300 - 24) / 375 = 0.736 → 0.74
		assert.equal(fitScale({ width: 300, height: 900 }, preset), 0.74);
		// 高度紧：可用 500 → (500 - 24) / 667 = 0.714 → 0.71
		assert.equal(fitScale({ width: 900, height: 500 }, preset), 0.71);
	});

	it("量不到尺寸（还没挂载）时先按 1 算，不要给出 0 或 NaN", () => {
		const preset = phonePresetOf("iphone14");
		assert.equal(fitScale({ width: 0, height: 0 }, preset), 1);
	});

	it("极窄也不小于 0.25（再小就只剩缩略图）", () => {
		const preset = phonePresetOf("tablet");
		assert.equal(fitScale({ width: 100, height: 100 }, preset), 0.25);
	});
});
