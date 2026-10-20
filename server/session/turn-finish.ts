/**
 * 回合收尾（从 runtime 抽出来：400 行护栏）。
 *
 * 要做的事按顺序：
 *   1. 从 turns 里摘掉这个会话的回合（并行时别的会话不受影响）
 *   2. state.running 只复位"当前会话"（ADR-0030 §2）
 *   3. 排空该会话的排队消息（ADR-0030 的「排队」）
 *   4. 审批状态收尾（ADR-0006：悬着的审批按拒绝处理）
 *   5. 助手消息整条落盘 + 建议标记解析（ADR-0022）
 *   6. 刷新统计与 pi 会话列表，推快照
 */
import { emptyRunning, type ServerState } from "../snapshot/state.js";
import { settleTurnMarkers } from "./turn-markers.js";
import type { QueuedMessage } from "./turn-queue.js";

export type TurnLike = { messageId: string; rawText: string };

export function createTurnFinisher(deps: {
	state: ServerState;
	turns: Map<string, TurnLike>;
	shiftQueued: (conversationId: string) => QueuedMessage | null;
	sendNext: (message: QueuedMessage, conversationId: string) => void;
	cancelPending: () => void;
	settle: (input: { conversationId: string; messageId: string; rawText: string }) => void;
	touchConversation: (conversationId: string) => void;
	refreshStats: () => void;
	refreshProjects: () => void;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}) {
	return async (conversationId: string, reason: "done" | "interrupted" | "error"): Promise<void> => {
		const turn = deps.turns.get(conversationId);
		deps.turns.delete(conversationId);
		const { [conversationId]: _gone, ...rest } = deps.state.runningByConversation;
		deps.state.runningByConversation = rest;
		if (conversationId === deps.state.activeId) {
			const keepError = reason === "error" || deps.state.running.status === "error";
			deps.state.running = { ...emptyRunning(), status: keepError ? "error" : "idle" };
		}
		deps.refreshStats();
		const next = deps.shiftQueued(conversationId);
		if (next) deps.sendNext(next, conversationId);
		deps.state.pendingApproval = null;
		deps.cancelPending();
		if (turn) deps.settle({ conversationId, messageId: turn.messageId, rawText: turn.rawText });
		deps.touchConversation(conversationId);
		deps.refreshProjects();
		if (reason === "interrupted") deps.notice("回合已中断", "info");
		deps.pushSnapshot();
	};
}

/** 把 settleTurnMarkers 的调用签名收成上面那个形状（避免 runtime 里再写一段） */
export function settleWith(state: ServerState, nextId: (prefix: string) => string) {
	return (input: { conversationId: string; messageId: string; rawText: string }) =>
		settleTurnMarkers({ state, ...input, nextId });
}

/** 等这一轮的落盘完成（同一会话的下一次回合不应与其持久化重叠） */
export async function awaitTurnPersisted(
	turns: Map<string, { finish?: Promise<void> }>,
	conversationId: string,
): Promise<void> {
	const pending = turns.get(conversationId)?.finish;
	if (!pending) return;
	await pending;
	const turn = turns.get(conversationId);
	if (turn) turn.finish = undefined;
}

/** 维护 runningByConversation（并行时侧栏可以同时多行转圈） */
export function setRunning(
	state: ServerState,
	conversationId: string,
	value: { status: "idle" | "streaming" | "awaiting_approval" | "error"; turnStartedAt: number } | null,
): void {
	if (value === null) {
		const { [conversationId]: _gone, ...rest } = state.runningByConversation;
		state.runningByConversation = rest;
		return;
	}
	state.runningByConversation = { ...state.runningByConversation, [conversationId]: value };
}
