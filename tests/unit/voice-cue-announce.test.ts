/**
 * 「完成」只响一次（用户 2026-11-02：「任务完成时为什么播放了两遍任务已完成语音」，随后定调
 * 「任务已完成、系统出错这种声音就行」—— 状态类事件只响提示音，不再念短句）。
 *
 * 两层各自钉住：
 *   ① 判定器（`planCues`）：一轮只发一条完成 cue —— 但并行 / 后台会话一起收尾时，它们是
 *      **不同的回合**，按规矩就得各发一条（所以出口必须再合一次，这就是本文件的重点）；
 *   ② 出口（`shouldAnnounceDone`）：同一拍的多条算一次，且 1.5s 内不重复响 —— 否则并行收尾
 *      会「叮」两声，听起来和「播了两遍」是一回事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Snapshot, UiMessage } from "../../server/protocol.ts";
import {
	createAnnounceMemory,
	createCueMemory,
	DONE_ANNOUNCE_GAP_MS,
	planCues,
	shouldAnnounceDone,
} from "../../web/src/voice-cue-logic.ts";

function message(id: string, role: UiMessage["role"], endedAt?: number): UiMessage {
	return { id, role, ts: 1, endedAt, blocks: [{ kind: "text", text: "hi" }] } as UiMessage;
}

function snapshot(input: {
	conversationId: string;
	messages?: UiMessage[];
	byConversation: Record<string, { status: "idle" | "streaming"; turnStartedAt: number }>;
}): Snapshot {
	return {
		active: { conversationId: input.conversationId, messages: input.messages ?? [] },
		running: { status: "idle", conversationId: null, turnStartedAt: null, streamingText: "", activeTool: null },
		runningByConversation: input.byConversation,
		pendingApproval: null,
		notices: [],
	} as unknown as Snapshot;
}

describe("并行收尾：判定器各发一条，出口只响一次", () => {
	it("两条会话同一拍收尾 → 2 条完成 cue，却只放行一次声音", () => {
		const memory = createCueMemory();
		// 第一拍：两条会话都在跑（c2 是当前会话，已经有一条用户消息）
		planCues(
			memory,
			snapshot({
				conversationId: "c2",
				messages: [message("m1", "user")],
				byConversation: {
					c1: { status: "streaming", turnStartedAt: 100 },
					c2: { status: "streaming", turnStartedAt: 200 },
				},
			}),
		);
		// 第二拍：两条同时收尾（c1 后台没有消息可看，c2 的助手消息已落盘）
		const cues = planCues(
			memory,
			snapshot({
				conversationId: "c2",
				messages: [message("m1", "user"), message("m2", "assistant", 999)],
				byConversation: {},
			}),
		);
		const done = cues.filter((cue) => cue.kind === "done");
		assert.equal(done.length, 2, "两条会话各自收尾，判定器按规矩各发一条");

		const announced = createAnnounceMemory();
		// 出口只拿到「一次」：多条完成合成一批，没有朗读时 text 为 null（只响提示音）
		assert.equal(shouldAnnounceDone(announced, null, 1000), true, "这一批该响");
		assert.equal(shouldAnnounceDone(announced, null, 1100), false, "同一批 / 紧接着的一拍不该再响");
	});
});

describe("相同内容 1.5s 内只响一次", () => {
	it("第一次放行，紧接着的同内容被拦下", () => {
		const memory = createAnnounceMemory();
		assert.equal(shouldAnnounceDone(memory, null, 1000), true);
		assert.equal(shouldAnnounceDone(memory, null, 1000 + DONE_ANNOUNCE_GAP_MS - 1), false);
	});

	it("窗口过了就照常响（被拦下的那一拍不动记忆，不会把后面的也吃掉）", () => {
		const memory = createAnnounceMemory();
		assert.equal(shouldAnnounceDone(memory, null, 1000), true);
		assert.equal(shouldAnnounceDone(memory, null, 1200), false);
		assert.equal(shouldAnnounceDone(memory, null, 1200 + DONE_ANNOUNCE_GAP_MS), true);
	});

	it("开着「朗读回复」时按回复内容去抖：不同回复各自放行", () => {
		const memory = createAnnounceMemory();
		assert.equal(shouldAnnounceDone(memory, "第一条回复", 1000), true);
		assert.equal(shouldAnnounceDone(memory, "第一条回复", 1100), false, "同一条回复不重复念");
		assert.equal(shouldAnnounceDone(memory, "第二条回复", 1200), true);
	});

	it("只响提示音与朗读互不掩盖", () => {
		const memory = createAnnounceMemory();
		assert.equal(shouldAnnounceDone(memory, null, 1000), true);
		assert.equal(shouldAnnounceDone(memory, "一条回复", 1050), true);
	});
});
