/**
 * 底部状态栏的**默认显隐与默认顺序**（`web/src/ui-prefs.ts`）。
 *
 * 钉住一条产品决定（用户 2026-11-23）：「底部只要 设置 / 引擎 / 审批模式」。
 * 排队 / 工作中 / 上下文 / 完整历史 / 系统提示词 / 终端 / 顶部 默认隐藏，
 * 但仍在 设置 → 界面 → 底部 里可以勾回来、也可以拖动改顺序。
 *
 * 顺序同样被钉住：`STATUSBAR_TOGGLES` 就是默认从左到右的顺序（`DEFAULT_STATUSBAR_ORDER` 直接展开它）。
 * 存过的顺序永远优先（`readStoredBool` / `readStatusbarOrder` 都是先看本地值），
 * 所以改这张表不会把老用户的栏重排。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	STATUSBAR_ITEM_DEFAULT_ON,
	STATUSBAR_TOGGLES,
	statusbarItemDefault,
	type StatusbarToggle,
} from "../../web/src/ui-prefs.ts";

describe("底部状态栏默认值", () => {
	it("默认只显示 设置 / 引擎 / 审批模式", () => {
		const on = STATUSBAR_TOGGLES.filter((item) => statusbarItemDefault(item));
		assert.deepEqual(on, ["settings", "engine", "approval"]);
	});

	it("默认从左到右就是 设置 → 引擎 → 审批模式", () => {
		assert.deepEqual(STATUSBAR_TOGGLES.slice(0, 3), ["settings", "engine", "approval"]);
	});

	it("其余项目默认隐藏", () => {
		const hidden: StatusbarToggle[] = ["history", "prompt", "queued", "running", "context", "terminal", "top"];
		for (const item of hidden) assert.equal(statusbarItemDefault(item), false, `${item} 不该默认显示`);
	});

	it("默认表里不出现表外的 key（改漏了会当场炸）", () => {
		for (const item of STATUSBAR_ITEM_DEFAULT_ON) {
			assert.ok((STATUSBAR_TOGGLES as readonly string[]).includes(item), `${item} 不在 STATUSBAR_TOGGLES 里`);
		}
	});
});
