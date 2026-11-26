/**
 * 「插队」的 interrupt 档（ADR-0054）。
 *
 * 背景：pi 有原生的 `streamingBehavior: "steer"`，消息能插进**正在跑的那一轮**；
 * codex / dsh / opencode / claude 的协议都没有这个语义（一个会话同时只能跑一条 prompt）。
 * 于是给它们一条等价路径：**打断当前轮，把这条消息当下一轮立刻发出**。
 *
 * 这条路有三个容易写错的地方，正好各一个用例：
 *   1. 不能自己再调一次 `sendMessage` —— 那会撞掉引擎的 active 槽（实测 codex 8 秒不返回）；
 *      正确做法是把消息**留在队列里**，让回合收尾的排空当下一轮发；
 *   2. 打断必须真的等到落定，等不到就明确降级成排队（不能让用户看着「已插队」什么都没发生）；
 *   3. 回合已经结束了就不该再打断（那时排空会把它当下一轮发，打断只会打到空气）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnPlumbing, type QueuedView } from "../../server/session/turn-queue.ts";

type Notice = { text: string; level: "info" | "warn" | "error" };

function makePlumbing(overrides: {
	running?: () => boolean;
	settled?: () => Promise<boolean>;
	supportsSteer?: () => boolean;
}) {
	const state: { activeId: string | null; queued: QueuedView[] } = { activeId: "c1", queued: [] };
	const notices: Notice[] = [];
	const appended: { text: string; steer?: boolean }[] = [];
	const sent: { prompt: string; behavior?: string }[] = [];
	const counters = { interrupts: 0, sends: 0, steerMarks: 0 };
	let timeOffset = 0;

	const plumbing = createTurnPlumbing({
		state,
		engine: {
			sendMessage: async (_id, prompt, _onEvent, opts) => {
				counters.sends += 1;
				sent.push({ prompt, behavior: opts?.streamingBehavior });
			},
		},
		nextId: (prefix) => `${prefix}-${Math.random()}`,
		appendUser: (_id, text, steer) => appended.push({ text, steer }),
		notice: (text, level) => notices.push({ text, level }),
		pushSnapshot: () => {},
		isTurnRunning: overrides.running ?? (() => true),
		// 入队后把时钟推过「最小撤回窗口」（STEER_MIN_HOLD_MS = 1200），模拟用户已经等了一会儿
		now: () => Date.now() + timeOffset,
		steerMode: () => "interrupt",
		supportsSteer: overrides.supportsSteer ?? (() => true),
		interruptAndSettle: async () => {
			counters.interrupts += 1;
			return (overrides.settled ?? (async () => true))();
		},
		onInterruptForSteer: () => {
			counters.steerMarks += 1;
		},
	});

	return {
		plumbing,
		state,
		notices,
		appended,
		sent,
		counters,
		/** 把时钟推到最小撤回窗口之后（返回 0 时不需要） */
		passHoldWindow: () => {
			timeOffset = 5000;
		},
	};
}

test("interrupt 档：打断当前轮，但**不**自己再发一条 —— 消息留在队列里等收尾排空", async () => {
	const h = makePlumbing({});
	await h.plumbing.busy("steer", "先说这个", "先说这个", undefined, "c1");
	assert.equal(h.state.queued[0]?.mode, "steer", "插队项要先挂在队列里（界面上一张可撤回的待发行）");

	h.passHoldWindow();
	h.plumbing.flushSteer("c1");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(h.counters.interrupts, 1, "应该打断一次");
	assert.equal(h.counters.steerMarks, 1, "打断之前要打上「这是插队造成的」的标");
	assert.equal(h.counters.sends, 0, "绝不能在这里自己 sendMessage：那会撞掉引擎的 active 槽");
	assert.equal(h.appended.length, 0, "也不能自己写对话记录：排空那条路径会写，重复写就是两条一样的用户消息");
	assert.equal(h.state.queued[0]?.mode, "steer", "插队项必须还留在队列里，否则回合收尾时没人发它");
	assert.match(h.notices[0]?.text ?? "", /已插队/);
});

test("interrupt 档：引擎没在时限内停下 → 明确降级成排队（不装作插队成功）", async () => {
	const h = makePlumbing({ settled: async () => false });
	await h.plumbing.busy("steer", "先说这个", "先说这个", undefined, "c1");
	h.passHoldWindow();
	h.plumbing.flushSteer("c1");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(h.counters.interrupts, 1);
	assert.equal(h.counters.sends, 0);
	assert.match(h.notices.at(-1)?.text ?? "", /改为排队/);
	assert.equal(h.notices.at(-1)?.level, "warn");
});

test("interrupt 档：回合已经结束了就不再打断（排空会把它当下一轮发出去）", async () => {
	const h = makePlumbing({ running: () => false });
	await h.plumbing.busy("steer", "先说这个", "先说这个", undefined, "c1");
	h.passHoldWindow();
	h.plumbing.flushSteer("c1");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(h.counters.interrupts, 0, "回合都没在跑，打断只会打到空气");
	assert.equal(h.state.queued[0]?.mode, "steer", "条目要留着，让收尾排空当下一轮发");
});

test("排空时插队项优先：先排队的不能插在插队的那条前面", async () => {
	const h = makePlumbing({});
	await h.plumbing.busy("queue", "排队那条", "排队那条", undefined, "c1");
	await h.plumbing.busy("steer", "插队那条", "插队那条", undefined, "c1");

	const next = h.plumbing.queue.shiftSteerFirst("c1");
	assert.equal(next?.text, "插队那条", "用户点的是插队，就不能先跑他之前排的那条");
	assert.equal(next?.mode, "steer");
	assert.equal(h.state.queued.length, 1);
	assert.equal(h.state.queued[0]?.text, "排队那条", "排队那条还在，下一轮结束再发");
});

test("native 档（pi）行为不变：走引擎自己的 steer，不调 interruptAndSettle", async () => {
	const h = makePlumbing({});
	// 换成 native：同一个 plumbing 的 steerMode 是 interrupt，这里单独建一个验证对照
	const state: { activeId: string | null; queued: QueuedView[] } = { activeId: "c1", queued: [] };
	let timeOffset = 0;
	const sent: { prompt: string; behavior?: string }[] = [];
	let interrupts = 0;
	const plumbing = createTurnPlumbing({
		state,
		engine: {
			sendMessage: async (_id, prompt, _onEvent, opts) => {
				sent.push({ prompt, behavior: opts?.streamingBehavior });
			},
		},
		nextId: (prefix) => `${prefix}-${Math.random()}`,
		appendUser: () => {},
		notice: () => {},
		pushSnapshot: () => {},
		isTurnRunning: () => true,
		now: () => Date.now() + timeOffset,
		steerMode: () => "native",
		interruptAndSettle: async () => {
			interrupts += 1;
			return true;
		},
	});
	await plumbing.busy("steer", "插一句", "插一句", undefined, "c1");
	timeOffset = 5000;
	plumbing.flushSteer("c1");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(sent, [{ prompt: "插一句", behavior: "steer" }]);
	assert.equal(interrupts, 0, "native 档不该打断：pi 的是同轮插入");
	void h;
});
