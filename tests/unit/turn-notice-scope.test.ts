/**
 * 回合级的提示（超时 / 中断 / 失败 / 附件）必须带上「所属会话」。
 *
 * 与 `steer-notice-scope.test.ts` 同一个根因：提示默认是全局的，于是右侧临时聊天里
 * 报的错会冒到左边正式会话的提示条上。带上 conversationId 后，界面按会话过滤（NoticeBar）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeTurnWatchdog } from "../../server/session/turn-watchdog.ts";

type Notice = { text: string; conversationId?: string };

test("回合超时的提示挂在被中断的那条会话上", () => {
	const notices: Notice[] = [];
	const interrupted: string[] = [];
	let fire: (() => void) | null = null;
	const watchdog = createRuntimeTurnWatchdog({
		timeoutMs: 1000,
		engine: { interrupt: async (conversationId: string) => void interrupted.push(conversationId) },
		isWaitingForUser: () => false,
		notice: (text: string, _level: "info" | "warn" | "error", conversationId?: string) =>
			void notices.push({ text, ...(conversationId ? { conversationId } : {}) }),
		setTimer: (callback) => {
			fire = callback;
			return 1;
		},
		clearTimer: () => {},
	});

	watchdog.start("side-chat-9");
	assert.ok(fire, "应该已经挂上定时器");
	(fire as () => void)();

	const timeout = notices.find((notice) => notice.text.includes("没结束"));
	assert.ok(timeout, "应该有一条超时提示");
	assert.equal(timeout.conversationId, "side-chat-9");
	assert.deepEqual(interrupted, ["side-chat-9"]);
});
