/**
 * 近讲门限的兜底放开（`web/src/gate-fallback.ts`）。
 *
 * 这条规则决定「你小声说话时会不会整段被当成噪声丢掉」—— 阈值错了要么永远不放开
 * （小声=没反应），要么一点就放开（门限形同虚设）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldFallbackOpen } from "../../web/src/gate-fallback.ts";

describe("shouldFallbackOpen", () => {
	it("没被挡就不放开", () => {
		assert.equal(shouldFallbackOpen({ blockedForMs: 0, fallbackMs: 1500 }), false);
	});

	it("挡的时间不够不放开", () => {
		assert.equal(shouldFallbackOpen({ blockedForMs: 900, fallbackMs: 1500 }), false);
	});

	it("连续被挡到阈值就放开（小声 / 离得远）", () => {
		assert.equal(shouldFallbackOpen({ blockedForMs: 1500, fallbackMs: 1500 }), true);
		assert.equal(shouldFallbackOpen({ blockedForMs: 3000, fallbackMs: 1500 }), true);
	});

	it("阈值配坏（0 / 负数 / NaN）时不放开，别把门限弄成永远放行", () => {
		assert.equal(shouldFallbackOpen({ blockedForMs: 5000, fallbackMs: 0 }), false);
		assert.equal(shouldFallbackOpen({ blockedForMs: 5000, fallbackMs: -1 }), false);
		assert.equal(shouldFallbackOpen({ blockedForMs: Number.NaN, fallbackMs: 1500 }), false);
	});
});
