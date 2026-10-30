/**
 * 顶栏入口的**默认勾选**（`web/src/ui-prefs.ts`）。
 *
 * 钉住一条产品决定（用户 2026-10-30）：「刚装完只勾模型 / 技能 / 语音 / MCP，不要全都勾上」。
 * 推送 / 插件 / 子代理 / 临时会话默认不显示 —— 它们按需在 设置 → 界面 → 顶栏 里勾回来。
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
	it("默认勾上的正好是模型 / 技能 / 语音 / MCP", () => {
		const on = APPBAR_ITEMS.filter((item) => appbarItemDefault(item));
		assert.deepEqual(on, ["models", "skills", "voice", "mcp"]);
	});

	it("推送 / 插件 / 子代理默认不勾", () => {
		for (const item of ["push", "plugins", "agents"] as const) {
			assert.equal(appbarItemDefault(item), false, `${item} 不该默认勾上`);
		}
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
