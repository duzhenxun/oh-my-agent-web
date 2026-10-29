/**
 * 「插队」的两个动作：`↩ 移回输入框` 与 `× 取消插队`（`server/session/turn-queue.ts`）。
 *
 * 用户点着那张待发卡片问「× 号是取消插队」——取消这条链路本身是对的（下面第一组测试锁住），
 * 真正的问题是**来不及点**：模型那边一次工具调用/一次收尾就是一次 step 边界，
 * 常常几百毫秒就来一个，插队卡片刚出现就被注入，`×` 按下去已经没东西可取消了。
 *
 * 所以加了 `STEER_MIN_HOLD_MS`（最小撤回窗口）：这段时间内即使边界到了也先不注入。
 * 提示语承诺「还没插进去、可以撤回」，就得给得出这段真实的时间。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTurnPlumbing, STEER_HOLD_MS, STEER_MIN_HOLD_MS } from "../../server/session/turn-queue.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PendingView = { id: string; conversationId: string; text: string; mode: string };

/** 装一套最小可用的 plumbing：引擎只记录「被注入了什么」 */
function harness(options: { turnRunning?: () => boolean } = {}) {
	const injected: string[] = [];
	const appended: string[] = [];
	const notices: string[] = [];
	const state = { activeId: "c1", queued: [] as PendingView[] };
	let seq = 0;
	const plumbing = createTurnPlumbing({
		state: state as never,
		engine: {
			sendMessage: async (_id: string, text: string) => void injected.push(text),
		} as never,
		nextId: (prefix: string) => `${prefix}-${++seq}`,
		appendUser: (_id: string, text: string) => void appended.push(text),
		notice: (text: string) => void notices.push(text),
		pushSnapshot: () => {},
		isTurnRunning: options.turnRunning ?? (() => true),
	});
	const queueSteer = (text: string) => plumbing.busy("steer", text, text, [], "c1");
	return { plumbing, state, injected, appended, notices, queueSteer };
}

describe("× 取消插队：取消了就一定不会插进去", () => {
	it("排队后立刻取消 → 过了 3 秒兜底也绝不注入、不往对话里塞消息", async () => {
		const h = harness();
		await h.queueSteer("CANCEL_ME");
		assert.equal(h.state.queued.length, 1);

		const removed = h.plumbing.queue.cancel(h.state.queued[0]!.id);
		assert.equal(removed, "steer");
		assert.equal(h.state.queued.length, 0);

		await sleep(STEER_HOLD_MS + 400);
		assert.deepEqual(h.injected, []);
		assert.deepEqual(h.appended, []);
	});

	it("取消一条、留下另一条：留下的那条照常注入", async () => {
		const h = harness();
		await h.queueSteer("DROP");
		await h.queueSteer("KEEP");
		const dropId = h.state.queued.find((item) => item.text === "DROP")!.id;
		h.plumbing.queue.cancel(dropId);

		// 越过最小窗口后手动触发一次边界
		await sleep(STEER_MIN_HOLD_MS + 50);
		h.plumbing.flushSteer("c1");
		assert.deepEqual(h.injected, ["KEEP"]);
		assert.deepEqual(h.appended, ["KEEP"]);
	});

	it("取消不存在的 id → 返回 null（界面据此提示「已经不在了」）", () => {
		const h = harness();
		assert.equal(h.plumbing.queue.cancel("q-not-exist"), null);
	});
});

describe("最小撤回窗口：边界来得太快也先给用户一点时间", () => {
	it("刚入队就遇到 step 边界 → **不立刻注入**，而是等窗口过去", async () => {
		const h = harness();
		await h.queueSteer("WAIT_A_BIT");

		h.plumbing.flushSteer("c1"); // 模拟「立刻来了一个 step 边界」
		assert.deepEqual(h.injected, [], "窗口内不该注入");
		assert.equal(h.state.queued.length, 1, "窗口内还挂在待发里，× 仍然可点");

		await sleep(STEER_MIN_HOLD_MS + 150);
		h.plumbing.flushSteer("c1"); // 窗口过后再来一次边界
		assert.deepEqual(h.injected, ["WAIT_A_BIT"]);
	});

	it("窗口内取消 → 之后即使再触发边界也不会注入", async () => {
		const h = harness();
		await h.queueSteer("CANCEL_IN_WINDOW");
		h.plumbing.flushSteer("c1"); // 被窗口挡住
		h.plumbing.queue.cancel(h.state.queued[0]!.id);

		await sleep(STEER_MIN_HOLD_MS + 150);
		h.plumbing.flushSteer("c1");
		assert.deepEqual(h.injected, []);
	});

	it("最小窗口明显小于兜底窗口（否则插队就退化成排队了）", () => {
		assert.ok(STEER_MIN_HOLD_MS < STEER_HOLD_MS);
	});
});
