/**
 * 「插队」按引擎能力降级（ADR-0043）。
 *
 * 背景：宿主原来对**所有**引擎都允许插队，做法是在回合进行中再调一次 `engine.sendMessage`。
 * 但 codex / dsh / opencode 的底层协议（JSON-RPC / ACP）都是「一个会话同时只能跑一条 prompt」，
 * 第二条会把引擎自己的活跃回合覆盖掉：
 *   - codex：第一条回合的 promise 永不 resolve（`codex.ts` 的 `await done`）→ 该会话永久 busy；
 *   - dsh / opencode：事件按 `active` 路由，原回合的增量被投给只收 error 的监听器 → 整轮输出丢失。
 *
 * 所以宿主按 `capabilities.steer` 降级：不能插就排队，并且**说出来**。
 * 这两条路径都是纯逻辑，可以直接测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBusyHandler, createTurnPlumbing, type QueuedView } from "../../server/session/turn-queue.ts";

type Notice = { text: string; level: "info" | "warn" };

const makeBusy = (steerable: boolean | undefined) => {
	const queued: { mode: string; text: string }[] = [];
	const notices: Notice[] = [];
	const busy = createBusyHandler({
		queue: (_conversationId, text, _attachments, mode) => {
			queued.push({ mode, text });
			return queued.length;
		},
		appendUser: () => {},
		notice: (text, level) => notices.push({ text, level }),
		pushSnapshot: () => {},
		...(steerable === undefined ? {} : { supportsSteer: () => steerable }),
	});
	return { busy, queued, notices };
};

test("引擎不支持插队 → 降级成排队，并明确告知（不是静默变成排队）", async () => {
	const { busy, queued, notices } = makeBusy(false);
	const result = await busy("steer", "你好", "你好", undefined, "c1");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(queued, [{ mode: "queue", text: "你好" }], "必须进 queue，不能进 steer");
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.level, "warn");
	assert.match(notices[0]?.text ?? "", /不支持插队/);
	assert.match(notices[0]?.text ?? "", /排队/);
});

test("引擎支持插队 → 仍然进 steer（pi 的行为一点不变）", async () => {
	const { busy, queued, notices } = makeBusy(true);
	const result = await busy("steer", "你好", "你好", undefined, "c1");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(queued, [{ mode: "steer", text: "你好" }]);
	assert.equal(notices[0]?.level, "info");
	assert.match(notices[0]?.text ?? "", /已插队/);
});

test("没传 supportsSteer 时按「支持」处理（老调用方 / 单测兼容）", async () => {
	const { busy, queued } = makeBusy(undefined);
	await busy("steer", "你好", "你好", undefined, "c1");
	assert.deepEqual(queued, [{ mode: "steer", text: "你好" }]);
});

test("队列里残留 steer 条目 + 引擎不支持 → flushSteer 改成排队，绝不第二次调 sendMessage", async () => {
	let steerable = true;
	let timeOffset = 0;
	const notices: Notice[] = [];
	const state: { activeId: string | null; queued: QueuedView[] } = { activeId: "c1", queued: [] };
	let sendCount = 0;
	const appended: { text: string; steer?: boolean }[] = [];

	const plumbing = createTurnPlumbing({
		state,
		engine: {
			sendMessage: async () => {
				sendCount += 1;
			},
		},
		nextId: (prefix) => `${prefix}-${sendCount}-${Math.random()}`,
		appendUser: (_id, text, steer) => appended.push({ text, steer }),
		notice: (text, level) => notices.push({ text, level }),
		pushSnapshot: () => {},
		isTurnRunning: () => true,
		// 时钟：入队时是 0 偏移，入队后再推 5 秒，越过「最小撤回窗口」（STEER_MIN_HOLD_MS = 1200）
		now: () => Date.now() + timeOffset,
		supportsSteer: () => steerable,
	});

	// 先用「支持插队」的引擎把一条挂进队列（模拟能力字段是后加的、老会话里留着 steer 项）
	await plumbing.busy("steer", "插一句", "插一句", undefined, "c1");
	assert.equal(state.queued[0]?.mode, "steer");

	// 中途引擎被切成不支持插队的那个，边界到了（同时越过最小撤回窗口）
	steerable = false;
	timeOffset = 5000;
	plumbing.flushSteer("c1");

	assert.equal(sendCount, 0, "这条路径上不能再调 sendMessage（那会覆盖引擎的活跃回合）");
	assert.equal(appended.length, 0, "也不能写进对话记录（否则界面显示插队成功、模型却没收到）");
	assert.equal(state.queued[0]?.mode, "queue", "应退回队列，等这一轮结束再发");
	assert.match(notices.at(-1)?.text ?? "", /改为排队/);
});

test("引擎支持 + 边界到了 → 正常注入，并把这条标成 steer", async () => {
	const state: { activeId: string | null; queued: QueuedView[] } = { activeId: "c1", queued: [] };
	let timeOffset = 0;
	const appended: { text: string; steer?: boolean }[] = [];
	const sent: { prompt: string; behavior?: string }[] = [];

	const plumbing = createTurnPlumbing({
		state,
		engine: {
			sendMessage: async (_id, prompt, _onEvent, opts) => {
				sent.push({ prompt, behavior: opts?.streamingBehavior });
			},
		},
		nextId: (prefix) => `${prefix}-${Math.random()}`,
		appendUser: (_id, text, steer) => appended.push({ text, steer }),
		notice: () => {},
		pushSnapshot: () => {},
		isTurnRunning: () => true,
		now: () => Date.now() + timeOffset,
		supportsSteer: () => true,
	});

	await plumbing.busy("steer", "插一句", "插一句", undefined, "c1");
	timeOffset = 5000; // 越过最小撤回窗口，模拟真的到了 step 边界
	plumbing.flushSteer("c1");
	// sendMessage 是 void 调用的，等一个 tick 让它跑完
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(appended, [{ text: "插一句", steer: true }]);
	assert.deepEqual(sent, [{ prompt: "插一句", behavior: "steer" }]);
});
