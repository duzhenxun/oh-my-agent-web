/**
 * 设置面板标签顺序的清洗（`web/src/settings-tabs.ts`）。
 *
 * 这里钉住一条承诺：**以后往设置里加一页，老用户也能看见它** ——
 * 浏览器里存的是上一次拖过的顺序（比如六项），新页不在里面；清洗时按出厂顺序把它补回去，
 * 而不是「存过顺序就先信存储」。不补的话，新加的「远程」页对老用户等于不存在。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS_ORDER, normalizeSettingsOrder, parseSettingsOrder } from "../../web/src/settings-tabs.ts";

describe("设置标签顺序", () => {
	it("出厂顺序：远程排在快捷键后面", () => {
		assert.deepEqual(
			[...DEFAULT_SETTINGS_ORDER],
			["ui", "general", "appearance", "theme", "language", "shortcuts", "remote"],
		);
	});

	it("老存储（没有 remote 这一项）→ 补在最后，其余顺序照旧", () => {
		assert.deepEqual(normalizeSettingsOrder(["theme", "shortcuts", "ui", "general", "appearance", "language"]), [
			"theme",
			"shortcuts",
			"ui",
			"general",
			"appearance",
			"language",
			"remote",
		]);
	});

	it("未知项丢掉、重复项只留第一个、缺的按出厂顺序补齐", () => {
		assert.deepEqual(parseSettingsOrder(JSON.stringify(["ui", "ui", "nope", "general"])), [
			"ui",
			"general",
			"appearance",
			"theme",
			"language",
			"shortcuts",
			"remote",
		]);
	});

	it("没存过 / 存了半截 JSON → 出厂顺序（不白屏）", () => {
		assert.deepEqual(parseSettingsOrder(null), [...DEFAULT_SETTINGS_ORDER]);
		assert.deepEqual(parseSettingsOrder("{oops"), [...DEFAULT_SETTINGS_ORDER]);
	});
});
