/**
 * 「连续听写」的续听决策（`web/src/continuous-listen.ts`）。
 *
 * 这层判断全是**否定条件**，每一条都对应一个真实的坑，漏一条就变成
 * 「点了停它还在听」「切到别的标签页还在占麦克风」「桥没起来时无限重开」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldResumeListening, type ResumeInput } from "../../web/src/continuous-listen.ts";

const base: ResumeInput = {
	continuous: true,
	manualPause: false,
	status: "idle",
	hidden: false,
	errorStreak: 0,
	maxErrorStreak: 2,
};

describe("shouldResumeListening", () => {
	it("开着连续听写、刚发完（idle）→ 续听", () => {
		assert.equal(shouldResumeListening(base), true);
	});

	it("没开连续听写就不续", () => {
		assert.equal(shouldResumeListening({ ...base, continuous: false }), false);
	});

	it("用户手动停过 / 撤销过 → 不续（不能「说停还在听」）", () => {
		assert.equal(shouldResumeListening({ ...base, manualPause: true }), false);
	});

	it("还在听 / 正在发的时候不续（否则两个会话抢麦克风）", () => {
		assert.equal(shouldResumeListening({ ...base, status: "listening" }), false);
		assert.equal(shouldResumeListening({ ...base, status: "sending" }), false);
	});

	it("页面不可见不续（切走还占着麦克风很烦）", () => {
		assert.equal(shouldResumeListening({ ...base, hidden: true }), false);
	});

	it("连续出错到上限就停手（桥没起来 / 权限被撤时别热循环）", () => {
		assert.equal(shouldResumeListening({ ...base, errorStreak: 1 }), true);
		assert.equal(shouldResumeListening({ ...base, errorStreak: 2 }), false);
		assert.equal(shouldResumeListening({ ...base, errorStreak: 9 }), false);
	});
});
