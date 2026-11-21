/**
 * 「等多久发送」的换算与钳制（`web/src/silence-ring.ts`）。
 *
 * 设置面板填秒、状态机用毫秒；换算或钳制错了会变成「设 2 秒却 0.2 秒就发」这种
 * 很难自己发现的 bug，所以把边界钉住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampSilenceMs, SILENCE_MAX_MS, SILENCE_MIN_MS } from "../../web/src/silence-ring.ts";

const DEFAULT = 2200;

describe("clampSilenceMs", () => {
	it("秒 → 毫秒", () => {
		assert.equal(clampSilenceMs(2.2, DEFAULT), 2200);
		assert.equal(clampSilenceMs(3, DEFAULT), 3000);
	});

	it("低于下限 / 高于上限都夹住", () => {
		assert.equal(clampSilenceMs(0.1, DEFAULT), SILENCE_MIN_MS);
		assert.equal(clampSilenceMs(99, DEFAULT), SILENCE_MAX_MS);
	});

	it("存坏了就回落默认（老版本没这一项 / 手改过 localStorage）", () => {
		assert.equal(clampSilenceMs(undefined, DEFAULT), DEFAULT);
		assert.equal(clampSilenceMs("abc", DEFAULT), DEFAULT);
		assert.equal(clampSilenceMs(Number.NaN, DEFAULT), DEFAULT);
	});
});
