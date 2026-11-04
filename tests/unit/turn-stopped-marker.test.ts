/**
 * 「这一轮是被停掉的」要落到消息上（用户 2026-11-03：「如果是手动停止，就是任务已停止」）。
 *
 * 为什么不能在客户端猜：收尾那一刻，`running` 里「跑完了」和「被停掉」都是 idle，
 * 只有服务端知道 `reason`。所以收尾时把 `stopped` 写进助手消息，前端（语音播报）
 * 与历史都能读到 —— 否则手动停止也会念一句「任务已完成」，听着像同一件事说了两遍。
 *
 * 两条不能破的：
 *   ① 正常完成 / 出错**不许**带 `stopped`（不然每轮都是「已停止」）；
 *   ② 停过的消息不会被后来的重算抹掉（`stopped` 只加不清）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiMessage } from "../../server/protocol.ts";
import { settleTurnMarkers } from "../../server/session/turn-markers.ts";

function message(id: string, endedAt?: number): UiMessage {
	return { id, role: "assistant", ts: 1, endedAt, blocks: [{ kind: "text", text: "半截回答" }] } as UiMessage;
}

/** 只造 settleTurnMarkers 真正会读的那点状态 */
function stateWith(messages: UiMessage[]) {
	return { messages: { c1: messages } } as unknown as Parameters<typeof settleTurnMarkers>[0]["state"];
}

function settle(reason: "done" | "interrupted" | "error", messages: UiMessage[] = [message("m2")]) {
	const state = stateWith(messages);
	settleTurnMarkers({
		state,
		conversationId: "c1",
		messageId: "m2",
		rawText: "半截回答",
		reason,
		nextId: (prefix) => `${prefix}-1`,
		at: 999,
	});
	return state.messages.c1?.[0];
}

describe("收尾标记：被停掉的回合", () => {
	it("interrupted → 消息上带 stopped，并落 endedAt", () => {
		const settled = settle("interrupted");
		assert.equal(settled?.stopped, true);
		assert.equal(settled?.endedAt, 999);
	});

	it("正常完成 / 出错都不带 stopped", () => {
		assert.equal(settle("done")?.stopped, undefined);
		assert.equal(settle("error")?.stopped, undefined);
	});

	it("重算不会把 stopped 抹掉（只加不清）", () => {
		const stopped = settle("interrupted");
		const again = settle("done", [stopped!]);
		assert.equal(again?.stopped, true);
	});
});
