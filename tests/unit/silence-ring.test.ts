/**
 * 浮条静音进度环的数值（`web/src/silence-ring.ts`）。
 *
 * 这段逻辑只影响观感，但它直接决定「用户会不会以为没在听」：环该在静音时涨、说话时归零、
 * 到点刚好满。边界写错就会变成「一直半满」或者「说话时也在涨」，比不做更糟。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ringChanged, silenceRatio } from "../../web/src/silence-ring.ts";

describe("silenceRatio", () => {
	it("静音时长换算成 0–1", () => {
		assert.equal(silenceRatio(0, 1200), 0);
		assert.equal(silenceRatio(600, 1200), 0.5);
		assert.equal(silenceRatio(1200, 1200), 1);
	});

	it("超过阈值封顶在 1（别让环转过一圈）", () => {
		assert.equal(silenceRatio(5000, 1200), 1);
	});

	it("负数与畸形输入一律 0（时钟回拨 / 阈值没配好时不能乱填）", () => {
		assert.equal(silenceRatio(-200, 1200), 0);
		assert.equal(silenceRatio(Number.NaN, 1200), 0);
		assert.equal(silenceRatio(100, 0), 0);
	});
});

describe("ringChanged", () => {
	it("涨得够多才重渲染", () => {
		assert.equal(ringChanged(0, 0.05), false);
		assert.equal(ringChanged(0, 0.08), true);
		assert.equal(ringChanged(0.5, 0.9), true);
	});

	it("归零一定通知（说话 / 停听都要立刻把环清掉）", () => {
		assert.equal(ringChanged(0.6, 0), true);
		assert.equal(ringChanged(0, 0), false);
	});
});
