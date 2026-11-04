/**
 * 停止要真的停下来（`server/engine/pi-stop.ts`）：pi 的 `abort()` 在「正准备自动重试」的窗口里会扑空，
 * 所以发出停止后要隔一会儿补发，直到这一轮 settle。这里用假时钟与假会话锁住策略：
 *   1. 这一轮还没结束就一直补，结束了立刻收手；
 *   2. 回合已经换成下一轮，不再打扰它；
 *   3. 补满上限就放弃（不无限循环）；
 *   4. 补发失败不影响后面的补发。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepAbortingUntilSettled } from "../../server/engine/pi-stop.ts";

/** 假时钟：sleep 不真等，只记下调用次数 */
const instantSleep = async () => undefined;

describe("停止补发（keepAbortingUntilSettled）", () => {
	it("这一轮还在跑就补发，settle 之后立刻收手", async () => {
		let running = true;
		let aborts = 0;
		let cancels = 0;
		const sent = await keepAbortingUntilSettled({
			stillStopping: () => running,
			cancelRetry: () => {
				cancels += 1;
			},
			abortOnce: async () => {
				aborts += 1;
				// 第三次补发时 pi 终于 settle 了
				if (aborts === 3) running = false;
			},
			sleep: instantSleep,
		});
		assert.equal(aborts, 3);
		assert.equal(cancels, 3, "每次补发前都要先取消重试");
		assert.equal(sent, 3);
	});

	it("一开始就已经结束：一次都不补发", async () => {
		let aborts = 0;
		const sent = await keepAbortingUntilSettled({
			stillStopping: () => false,
			cancelRetry: () => undefined,
			abortOnce: async () => {
				aborts += 1;
			},
			sleep: instantSleep,
		});
		assert.equal(aborts, 0);
		assert.equal(sent, 0);
	});

	it("回合已经换成下一轮：收手，不误停下一轮", async () => {
		let turn = 1;
		const stopping = 1;
		let aborts = 0;
		const sent = await keepAbortingUntilSettled({
			stillStopping: () => turn === stopping,
			cancelRetry: () => undefined,
			abortOnce: async () => {
				aborts += 1;
				// 第一次补发后，排队的下一轮开始了
				turn = 2;
			},
			sleep: instantSleep,
		});
		assert.equal(aborts, 1);
		assert.equal(sent, 1);
	});

	it("补满上限就放弃，不无限循环", async () => {
		let aborts = 0;
		const sent = await keepAbortingUntilSettled({
			stillStopping: () => true,
			cancelRetry: () => undefined,
			abortOnce: async () => {
				aborts += 1;
			},
			sleep: instantSleep,
		});
		assert.equal(aborts, 8);
		assert.equal(sent, 8);
	});

	it("某次补发抛错，后面的补发照常进行", async () => {
		let running = true;
		let attempts = 0;
		await keepAbortingUntilSettled({
			stillStopping: () => running,
			cancelRetry: () => undefined,
			abortOnce: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("boom");
				if (attempts === 2) running = false;
			},
			sleep: instantSleep,
		});
		assert.equal(attempts, 2);
	});

	it("每一拍之间都要等（不能连着打 abort）", async () => {
		let running = true;
		const waits: number[] = [];
		await keepAbortingUntilSettled({
			stillStopping: () => running,
			cancelRetry: () => undefined,
			abortOnce: async () => {
				running = false;
			},
			sleep: async (ms) => {
				waits.push(ms);
			},
			tickMs: 750,
		});
		// 每一拍都先等再检查：第一拍补发后 settle，第二拍等完发现已结束就收手
		assert.deepEqual(waits, [750, 750]);
	});
});
