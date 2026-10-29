/**
 * 「回合完成要不要响一声」—— 提示音判定器的回归。
 *
 * 用户报的现象：任务明明跑完了，**一声都没有**（语音播报照常/或者也没有）。
 * 定位下来是两个「安静」的分支，都在 `isRealTurnEnd` / 状态跳变这里：
 *
 *   1. **新会话的第一轮**：开跑那一拍还没有助手消息 → `turnStartMark` 记成 `null`，
 *      而 `isRealTurnEnd(null, ...)` 以前直接 `return false`，于是这一轮永远不响；
 *   2. **收尾快照里 `endedAt` 晚一拍**（服务端 settle 找不到那条消息就一直不写）：
 *      状态跳变被消费掉了，下一拍 `endedAt` 落上时状态没变、不会再判一次，也是永远不响。
 *
 * 反过来还有两条不能破的：隐藏回合（「想想」）不该响，同一轮不能响两次。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Snapshot, UiMessage } from "../../server/protocol.ts";
import { createCueMemory, planCues, type Cue } from "../../web/src/voice-cue-logic.ts";

type Status = "idle" | "streaming" | "awaiting_approval" | "error";

function message(id: string, role: UiMessage["role"], endedAt?: number): UiMessage {
	return {
		id,
		role,
		ts: 1,
		endedAt,
		blocks: [{ kind: "text", text: "hi" }],
	} as UiMessage;
}

/** 只填判定器真正会读的字段（其余给最小可用值） */
function snapshot(input: {
	conversationId?: string;
	messages?: UiMessage[];
	status?: Status;
	/** 默认是这个会话自己在跑；传 null = 没有前台回合 */
	runningConversationId?: string | null;
	turnStartedAt?: number;
	byConversation?: Record<string, { status: Status; turnStartedAt: number }>;
}): Snapshot {
	const conversationId = input.conversationId ?? "c1";
	const status = input.status ?? "idle";
	const runningConversationId =
		input.runningConversationId === undefined ? (status === "idle" ? null : conversationId) : input.runningConversationId;
	return {
		active: { conversationId, messages: input.messages ?? [] },
		running: {
			status,
			conversationId: runningConversationId,
			turnStartedAt: input.turnStartedAt ?? null,
			streamingText: "",
			activeTool: null,
		},
		runningByConversation:
			input.byConversation ?? (status === "idle" ? {} : { [conversationId]: { status, turnStartedAt: input.turnStartedAt ?? 100 } }),
		pendingApproval: null,
		notices: [],
	} as unknown as Snapshot;
}

/** 喂一串快照，收集每一拍产出的 cue */
function play(steps: Snapshot[]): Cue[][] {
	const memory = createCueMemory();
	return steps.map((step) => planCues(memory, step));
}

const kinds = (cues: Cue[]): string[] => cues.map((cue) => cue.kind);

describe("提示音：回合完成判定", () => {
	it("新会话第一轮：开跑时还没有助手消息，跑完也要响", () => {
		const turns = play([
			snapshot({ messages: [message("m1", "user")] }),
			snapshot({
				messages: [message("m1", "user")],
				status: "streaming",
				turnStartedAt: 100,
			}),
			snapshot({
				messages: [message("m1", "user"), message("m2", "assistant")],
				status: "streaming",
				turnStartedAt: 100,
			}),
			snapshot({ messages: [message("m1", "user"), message("m2", "assistant", 999)] }),
		]);
		assert.deepEqual(kinds(turns[1] ?? []), ["start"]);
		assert.deepEqual(kinds(turns[3] ?? []), ["done"]);
	});

	it("收尾快照里 endedAt 晚一拍：下一拍补响，且只响一次", () => {
		const turns = play([
			snapshot({ messages: [message("m1", "user")], status: "streaming", turnStartedAt: 100 }),
			snapshot({
				messages: [message("m1", "user"), message("m2", "assistant")],
				status: "streaming",
				turnStartedAt: 100,
			}),
			// 运行状态已经收掉了，但 endedAt 还没落上
			snapshot({ messages: [message("m1", "user"), message("m2", "assistant")] }),
			// 这一拍才落上
			snapshot({ messages: [message("m1", "user"), message("m2", "assistant", 999)] }),
			// 再后面不该重复响
			snapshot({ messages: [message("m1", "user"), message("m2", "assistant", 999)] }),
		]);
		assert.deepEqual(kinds(turns[2] ?? []), []);
		assert.deepEqual(kinds(turns[3] ?? []), ["done"]);
		assert.deepEqual(kinds(turns[4] ?? []), []);
	});

	it("隐藏回合（「想想」）不新建消息：不响完成", () => {
		const done = message("m2", "assistant", 500);
		const turns = play([
			snapshot({ messages: [message("m1", "user"), done] }),
			// 隐藏回合开跑：消息数组没变
			snapshot({ messages: [message("m1", "user"), done], status: "streaming", turnStartedAt: 600 }),
			snapshot({ messages: [message("m1", "user"), done] }),
		]);
		assert.deepEqual(kinds(turns[1] ?? []), ["start"]);
		assert.deepEqual(kinds(turns[2] ?? []), []);
	});

	it("审批来回之后跑完：批准时不算完成，收尾才响", () => {
		const messages = [message("m1", "user"), message("m2", "assistant")];
		const turns = play([
			snapshot({ messages, status: "streaming", turnStartedAt: 100 }),
			snapshot({ messages, status: "awaiting_approval", turnStartedAt: 100 }),
			snapshot({ messages, status: "streaming", turnStartedAt: 100 }),
			snapshot({ messages: [message("m1", "user"), message("m2", "assistant", 999)] }),
		]);
		assert.deepEqual(kinds(turns[1] ?? []), []);
		assert.deepEqual(kinds(turns[2] ?? []), []);
		assert.deepEqual(kinds(turns[3] ?? []), ["done"]);
	});

	it("后台会话跑完也响（当前停在别的会话）", () => {
		const turns = play([
			snapshot({ conversationId: "c2", byConversation: { c1: { status: "streaming", turnStartedAt: 100 } } }),
			snapshot({ conversationId: "c2", byConversation: {} }),
		]);
		assert.deepEqual(kinds(turns[1] ?? []), ["done"]);
	});
});
