/**
 * 回合看门狗（ADR-0023）：全局只有 1 路在飞 ⇒ 卡住的回合等于整个应用不能用。
 * 时间由注入的定时器控制，测试完全确定。
 */
import { describe, expect, it } from "vitest";
import { createRuntimeTurnWatchdog, createTurnWatchdog, formatDuration } from "../../server/session/turn-watchdog.js";

/** 手控定时器：记录回调，测试里手动触发 */
function fakeTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let seq = 0;
	return {
		setTimer(callback: () => void, ms: number) {
			const id = ++seq;
			pending.set(id, { callback, ms });
			return id;
		},
		clearTimer(handle: unknown) {
			pending.delete(handle as number);
		},
		/** 触发当前所有待触发的定时器 */
		fire() {
			const entries = [...pending.entries()];
			pending.clear();
			for (const [, entry] of entries) entry.callback();
		},
		count: () => pending.size,
		lastMs: () => [...pending.values()].at(-1)?.ms,
	};
}

describe("createTurnWatchdog", () => {
	it("超时 → 回调拿到卡住的那个会话", () => {
		const timers = fakeTimers();
		const fired: string[] = [];
		const watchdog = createTurnWatchdog({
			timeoutMs: 1000,
			onTimeout: (conversationId) => fired.push(conversationId),
			isWaitingForUser: () => false,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		watchdog.start("conv-1");
		expect(timers.count()).toBe(1);
		expect(timers.lastMs()).toBe(1000);
		timers.fire();
		expect(fired).toEqual(["conv-1"]);
		expect(watchdog.armed()).toBe(false);
	});

	it("等用户审批时不计时：重新计时而不是中断", () => {
		const timers = fakeTimers();
		const fired: string[] = [];
		let waiting = true;
		const watchdog = createTurnWatchdog({
			timeoutMs: 500,
			onTimeout: (conversationId) => fired.push(conversationId),
			isWaitingForUser: () => waiting,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		watchdog.start("conv-1");
		timers.fire();
		expect(fired).toEqual([]); // 人还没点，不打断
		expect(timers.count()).toBe(1); // 但重新排了计时

		waiting = false;
		timers.fire();
		expect(fired).toEqual(["conv-1"]); // 人点过之后仍然卡住 → 中断
	});

	it("stop 之后不再触发（回合正常结束）", () => {
		const timers = fakeTimers();
		const fired: string[] = [];
		const watchdog = createTurnWatchdog({
			timeoutMs: 500,
			onTimeout: (conversationId) => fired.push(conversationId),
			isWaitingForUser: () => false,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		watchdog.start("conv-1");
		watchdog.stop();
		expect(timers.count()).toBe(0);
		expect(watchdog.armed()).toBe(false);
		expect(fired).toEqual([]);
	});

	it("并按会话：两个会话各自计时（ADR-0030 ①）", () => {
		const timers = fakeTimers();
		const watchdog = createTurnWatchdog({
			timeoutMs: 500,
			onTimeout: () => {},
			isWaitingForUser: () => false,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		watchdog.start("conv-1");
		watchdog.start("conv-2");
		expect(timers.count()).toBe(2);
		expect(watchdog.count()).toBe(2);
		// 停一个不影响另一个
		watchdog.stop("conv-1");
		expect(watchdog.armed("conv-1")).toBe(false);
		expect(watchdog.armed("conv-2")).toBe(true);
		// 同会话重复 start 仍然只有一个定时器
		watchdog.start("conv-2");
		expect(timers.count()).toBe(1);
	});
});

describe("createRuntimeTurnWatchdog", () => {
	it("超时会提示并中断对应会话", () => {
		const timers = fakeTimers();
		const interrupted: string[] = [];
		const notices: string[] = [];
		createRuntimeTurnWatchdog({
			timeoutMs: 20 * 60 * 1000,
			engine: { interrupt: async (conversationId) => void interrupted.push(conversationId) },
			isWaitingForUser: () => false,
			notice: (text) => notices.push(text),
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		}).start("conv-9");
		timers.fire();
		expect(interrupted).toEqual(["conv-9"]);
		expect(notices[0]).toContain("20 分钟");
		expect(notices[0]).toContain("自动中断");
	});
});

describe("formatDuration", () => {
	it("小于一分钟用秒，否则用分钟", () => {
		expect(formatDuration(10_000)).toBe("10 秒");
		expect(formatDuration(20 * 60 * 1000)).toBe("20 分钟");
		expect(formatDuration(0)).toBe("1 秒");
	});
});

describe("按会话隔离（ADR-0030 ① 的前置）", () => {
	it("A 卡住超时只中断 A，不影响 B 的计时", () => {
		const timers = fakeTimers();
		const interrupted: string[] = [];
		const watchdog = createTurnWatchdog({
			timeoutMs: 500,
			onTimeout: (id) => interrupted.push(id),
			isWaitingForUser: () => false,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		watchdog.start("A");
		watchdog.start("B");
		watchdog.stop("B"); // B 正常结束
		timers.fire();
		expect(interrupted).toEqual(["A"]);
	});
});
