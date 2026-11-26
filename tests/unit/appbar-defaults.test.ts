/**
 * 顶栏入口的**默认勾选**（`web/src/ui-prefs.ts`）。
 *
 * 钉住一条产品决定（用户 2026-11-24 收紧到只剩一条）：「顶部只要定时任务」。
 * 其余入口（模型 / 技能 / 推送 / 语音 / 插件 / MCP / 子代理 / 设置 / 临时会话）默认不显示 ——
 * 它们按需在 设置 → 界面 → 顶栏 里勾回来。模型和技能平时就在输入框上方和侧栏里，再看一遍只是重复。
 *
 * 顺序仍然被钉住了：`APPBAR_ITEMS` 的顺序就是顶栏从左到右的顺序。
 *
 * 这里只测**默认值**本身：存过值的优先级在 `readStoredBool` 里（存的值永远盖过默认），
 * 所以改这张表不会把老用户已经关掉的入口又打开。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	APPBAR_ITEMS,
	APPBAR_ITEM_DEFAULT_ON,
	APPBAR_TEMPCHAT_DEFAULT,
	appbarItemDefault,
} from "../../web/src/ui-prefs.ts";

describe("顶栏默认勾选", () => {
	it("默认勾上的只有定时任务", () => {
		const on = APPBAR_ITEMS.filter((item) => appbarItemDefault(item));
		assert.deepEqual(on, ["cron"]);
	});

	it("定时任务仍然排在顶栏靠前的位置（顺序就是显示顺序）", () => {
		assert.ok(APPBAR_ITEMS.indexOf("cron") < APPBAR_ITEMS.indexOf("skills"));
	});

	it("模型 / 技能 / 推送 / 语音 / 插件 / MCP / 子代理 / 设置 默认不勾", () => {
		for (const item of ["models", "skills", "push", "voice", "plugins", "mcp", "agents", "settings"] as const) {
			assert.equal(appbarItemDefault(item), false, `${item} 不该默认勾上`);
		}
	});

	it("Cron 提供独立的可配置顶栏入口", () => {
		assert.ok(APPBAR_ITEMS.includes("cron"));
	});

	it("「临时会话」默认不显示（它不是面板入口，单独一个 key）", () => {
		assert.equal(APPBAR_TEMPCHAT_DEFAULT, false);
	});

	it("默认表里不出现表外的 key（改漏了会当场炸）", () => {
		for (const item of APPBAR_ITEM_DEFAULT_ON) {
			assert.ok((APPBAR_ITEMS as readonly string[]).includes(item), `${item} 不在 APPBAR_ITEMS 里`);
		}
	});
});
