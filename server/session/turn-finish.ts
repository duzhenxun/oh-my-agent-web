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
import { actionsOf, emptyRunning, setActionsOf, type ServerState } from "../snapshot/state.js";
import { settleTurnMarkers } from "./turn-markers.js";
import type { QueuedMessage } from "./turn-queue.js";

type TurnLike = { messageId: string; rawText: string };

function createTurnFinisher(deps: {
	state: ServerState;
	turns: Map<string, TurnLike>;
	shiftQueued: (conversationId: string) => QueuedMessage | null;
	sendNext: (message: QueuedMessage, conversationId: string) => void;
	/** 按会话收掉悬着的审批（不能全局收：会误伤并行会话正等着的审批） */
	cancelPending: (conversationId: string, options?: { allTurnsDone?: boolean }) => void;
	settle: (input: {
		conversationId: string;
		messageId: string;
		rawText: string;
		/** 这一轮是怎么结束的：收尾后的推送通知要靠它区分「完成 / 被停 / 出错」 */
		reason: "done" | "interrupted" | "error";
	}) => void;
	touchConversation: (conversationId: string) => void;
	/** 按**回合自己的**会话刷新（不能不给 id：并行回合下 activeId 可能是别人） */
	refreshStats: (conversationId: string) => void;
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
		deps.refreshStats(conversationId);
		const next = deps.shiftQueued(conversationId);
		if (next) deps.sendNext(next, conversationId);
		// 只收**本会话**的审批：别的会话可能还在等你点确认（全局收会把它的工具调用静默拒掉）。
		// 弹窗状态由审批桥自己维护（队首被收掉才更新），这里不再直接置 null。
		deps.cancelPending(conversationId, { allTurnsDone: deps.turns.size === 0 });
		if (turn) deps.settle({ conversationId, messageId: turn.messageId, rawText: turn.rawText, reason });
		deps.touchConversation(conversationId);
		deps.refreshProjects();
		if (reason === "interrupted") deps.notice("回合已中断", "info");
		deps.pushSnapshot();
	};
}

/**
 * runtime 侧的整套收尾装配（落盘 + 队列排空 + 推送回调）。
 * 抽出来是为了让 runtime 只留一行：它自己的业务（推送通知）用 onTurnFinished 注入。
 */
export function createRuntimeTurnFinisher(options: {
	state: ServerState;
	turns: Map<string, { messageId: string; rawText: string }>;
	nextId: (prefix: string) => string;
	/** 回合结束的「现在」（写进消息的 endedAt；测试可注入固定值） */
	now?: () => number;
	shiftQueued: (conversationId: string) => QueuedMessage | null;
	sendNext: (message: QueuedMessage, conversationId: string) => void;
	/** 按会话收掉悬着的审批（不能全局收：会误伤并行会话正等着的审批） */
	cancelPending: (conversationId: string, options?: { allTurnsDone?: boolean }) => void;
	onTurnFinished?: (info: {
		conversationId: string;
		title: string;
		workspace: string;
		/** 是否以错误收尾 */
		failed: boolean;
		/** 是否被用户停掉 */
		interrupted: boolean;
	}) => void;
	touchConversation: (conversationId: string) => void;
	/** 按会话刷新（由 createTurnFinisher 传回合自己的 id） */
	refreshStats: (conversationId: string) => void;
	refreshProjects: () => void;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}): (conversationId: string, reason: "done" | "interrupted" | "error") => Promise<void> {
	return createTurnFinisher({
		state: options.state,
		turns: options.turns,
		shiftQueued: options.shiftQueued,
		sendNext: options.sendNext,
		cancelPending: options.cancelPending,
		settle: (info) => {
			settleWith(options.state, options.nextId, options.now)(info);
			const conversation = options.state.conversations.find((item) => item.id === info.conversationId);
			options.onTurnFinished?.({
				conversationId: info.conversationId,
				title: conversation?.title ?? "会话",
				workspace: conversation?.workspace ?? options.state.workspace,
				// 以前这里写死 false，而推送那边根本不看这个字段 —— 等于「失败也当成功推」。
				// 现在如实传下去（推送文案靠它加前缀）
				failed: info.reason === "error",
				interrupted: info.reason === "interrupted",
			});
		},
		touchConversation: options.touchConversation,
		refreshStats: options.refreshStats,
		refreshProjects: options.refreshProjects,
		notice: options.notice,
		pushSnapshot: options.pushSnapshot,
	});
}

/**
 * 把 settleTurnMarkers 的调用签名收成上面那个形状（避免 runtime 里再写一段）。
 *
 * 建议是**按会话**存的：这里负责取本会话已有的那份、算完再写回本会话 ——
 * 少了这一步，并行回合时 A 会话的建议会落到 B 会话的界面上（用户报的 bug）。
 */
function settleWith(state: ServerState, nextId: (prefix: string) => string, now?: () => number) {
	return (input: { conversationId: string; messageId: string; rawText: string }) => {
		const result = settleTurnMarkers({
			state,
			actions: actionsOf(state, input.conversationId),
			...input,
			nextId,
			at: now?.(),
		});
		setActionsOf(state, input.conversationId, result.actions);
	};
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
