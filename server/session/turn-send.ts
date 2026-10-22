/**
 * 「发一条用户消息并跑完这一轮」（从 runtime.ts 抽出：400 行护栏）。
 *
 * 这一段的顺序很讲究，动之前先读 ADR-0030 / ADR-0018：
 *   1. 附件先解析（失效的附件只降级、不拦）；
 *   2. 当前会话有回合在跑 → 交给排队/引导逻辑（`busy`）；
 *   3. 没有会话就懒建一个（并把发起者这个标签页的视图指过去，ADR-0033）；
 *   4. 历史会话第一次发消息前要先「打开」（引擎侧懒加载 + 读回历史）；
 *   5. 先落用户消息 + 占位助手消息 → 推一帧 → 再调引擎（界面立刻有反馈）；
 *   6. 引擎事件按 messageId 归位（`applyEngineEvent`），正文走增量事件；
 *   7. 引擎返回（成功或抛错）后统一走 `finishTurn` 收尾：排空队列 / 落盘 / 复位状态。
 */
import type { EnginePort } from "../engine/port.js";
import { createMarkerStreamFilter } from "../markers/actions.js";
import type { AttachmentRef, ProtocolError, RunningState, SendMode } from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import { resolveAttachments } from "./attachment-resolve.js";
import { setRunning } from "./turn-finish.js";
import type { TurnEventContext } from "./turn-events.js";
import { applyEngineEvent } from "./turn-events.js";
import type { TurnWatchdog } from "./turn-watchdog.js";

export type TurnSenderDeps = {
	state: ServerState;
	engine: EnginePort;
	now: () => number;
	nextId: (prefix: string) => string;
	titleChars: number;
	turns: Map<string, { messageId: string; filter: ReturnType<typeof createMarkerStreamFilter>; rawText: string }>;
	watchdog: TurnWatchdog;
	turnContext: TurnEventContext;
	notice: (text: string, level?: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
	/** 兜底收尾：引擎的 sendMessage 已返回却没吐 turn_end 时用它收场（否则 turns 永久留条目） */
	finishTurn: (conversationId: string, reason: "done" | "interrupted" | "error") => Promise<void>;
	/** 当前会话有回合在跑时的排队 / 引导处理；返回 null = 没接住，继续走正常发送 */
	busy: (
		mode: SendMode,
		text: string,
		promptText: string,
		images: Array<{ data: string; mimeType: string }>,
		attachments?: AttachmentRef[],
	) => Promise<{ ok: true } | { ok: false; error: ProtocolError } | null>;
	createConversation: (seedText: string) => Promise<string>;
	openConversation: (
		conversationId: string,
		refresh: (force?: boolean) => Promise<void>,
	) => Promise<import("../protocol.js").UiMessage[] | null>;
	isOpen: (conversationId: string) => boolean;
	refreshProjects: (force?: boolean) => Promise<void>;
	refreshModels: (conversationId: string) => Promise<void>;
	refreshThinking: (conversationId: string) => Promise<void>;
	clientView: { setActive: (clientId: string, conversationId: string) => void };
	touchConversation: (conversationId: string, patch?: { title?: string }) => void;
	uploadStore?: { read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null> };
};

export function createTurnSender(deps: TurnSenderDeps) {
	const { state } = deps;

	return async (
		text: string,
		attachments?: AttachmentRef[],
		mode: SendMode = "steer",
		targetConversationId?: string,
		clientId?: string,
		options: { hidden?: boolean } = {},
	): Promise<{ ok: true } | { ok: false; error: ProtocolError }> => {
		const resolved = await resolveAttachments(text, attachments, deps.uploadStore);
		for (const name of resolved.missing) deps.notice(`附件已失效（可能过期被清理）：${name}`, "warn");
		if (resolved.images.length > 0) deps.notice(`已附加 ${resolved.images.length} 张图片（视觉注入）`, "info");

		if (state.activeId !== null && deps.turns.has(state.activeId)) {
			const handled = await deps.busy(mode, text, resolved.promptText, resolved.images, attachments);
			if (handled) return handled;
		}

		let conversationId: string | null = null;
		let failed = false;
		try {
			// 没有任何会话时懒建一个（空实例的第一次发消息）；建了就把发起者的视图指过去
			const existing = targetConversationId ?? state.activeId;
			const created = existing ? null : await deps.createConversation(text);
			if (created && clientId) deps.clientView.setActive(clientId, created);
			const conv = (existing ?? created) as string; // 两者必有一个（ADR-0033）
			conversationId = conv;

			if (!deps.isOpen(conv)) {
				const opened = await deps.openConversation(conv, (force) => deps.refreshProjects(force));
				if (opened === null) throw new Error(`会话打不开：${conv}`);
				state.messages[conv] = opened;
				await deps.refreshModels(conv);
				await deps.refreshThinking(conv);
			}

			const ts = deps.now();
			const userMessage = appendText(createMessage(deps.nextId("msg"), "user", ts), text);
			const assistantMessage = createMessage(deps.nextId("msg"), "assistant", ts);

			// 隐藏回合（「想一想」）：不落任何消息，只靠 rawText 收标记
			if (!options.hidden) {
				const isFirstMessage = (state.messages[conv] ?? []).length === 0;
				if (isFirstMessage)
					deps.touchConversation(conv, { title: text.replace(/\s+/g, " ").trim().slice(0, deps.titleChars) });
				state.messages[conv] = [...(state.messages[conv] ?? []), userMessage, assistantMessage];
			}
			if (conv === state.activeId) {
				const running: RunningState = {
					status: "streaming",
					conversationId: conv,
					turnStartedAt: ts,
					streamingText: "",
					activeTool: null,
				};
				state.running = running;
			}
			state.actions = [];
			deps.turns.set(conv, { messageId: assistantMessage.id, filter: createMarkerStreamFilter(), rawText: "" });
			setRunning(state, conv, { status: "streaming", turnStartedAt: ts });
			deps.watchdog.start(conv);
			if (!options.hidden) deps.touchConversation(conv);

			deps.pushSnapshot();

			await deps.engine.sendMessage(
				conv,
				resolved.promptText,
				(event) => {
					applyEngineEvent(deps.turnContext, { conversationId: conv, messageId: assistantMessage.id, event });
				},
				resolved.images.length > 0 ? { images: resolved.images } : undefined,
			);
			return { ok: true };
		} catch (error) {
			failed = true;
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`回合执行失败：${message}`, "error");
			return { ok: false, error: { code: "session.turn_failed", message } };
		} finally {
			if (conversationId !== null) {
				deps.watchdog.stop(conversationId);
				// 引擎的 sendMessage 已经返回（成功或抛错）= 这一轮在引擎侧结束了。它要是没吐 turn_end
				// （provider 掉线 / 流被掐断 / 异常），这里必须补一次收尾：否则 turns 里留一个永不结束的
				// 条目 → isBusy() 恒为真 → 切引擎报 engine.busy，界面上还一直是「工作中」。
				// 异常分支以前先 `turns.delete` 了，这里就成了死代码 —— 那个会话的排队消息永久卡住、
				// 助手消息也永远不打 endedAt。统一交给 finishTurn，语义靠 reason 区分。
				if (deps.turns.has(conversationId)) await deps.finishTurn(conversationId, failed ? "error" : "done");
			}
		}
	};
}
