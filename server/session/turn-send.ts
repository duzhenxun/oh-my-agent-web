/**
 * 「发一条用户消息并跑完这一轮」（从 runtime.ts 抽出：400 行护栏）。
 *
 * 这一段的顺序很讲究，动之前先读 ADR-0030 / ADR-0018：
 *   1. 附件先解析（失效的附件只降级、不拦）；
 *   2. 当前会话有回合在跑 → 交给排队/插队逻辑（`busy`）；
 *   3. 没有会话就懒建一个（并把发起者这个标签页的视图指过去，ADR-0033）；
 *   4. 历史会话第一次发消息前要先「打开」（引擎侧懒加载 + 读回历史）；
 *   5. 先落用户消息 + 占位助手消息 → 推一帧 → 再调引擎（界面立刻有反馈）；
 *   6. 引擎事件按 messageId 归位（`applyEngineEvent`），正文走增量事件；
 *   7. 引擎返回（成功或抛错）后统一走 `finishTurn` 收尾：排空队列 / 落盘 / 复位状态。
 */
import type { EnginePort } from "../engine/port.js";
import { createMarkerStreamFilter } from "../markers/actions.js";
import type { AttachmentRef, ProtocolError, RunningState, SendMode } from "../protocol.js";
import { setActionsOf, type ServerState } from "../snapshot/state.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import { resolveAttachments } from "./attachment-resolve.js";
import { setRunning } from "./turn-finish.js";
import type { TurnEventContext } from "./turn-events.js";
import { applyEngineEvent } from "./turn-events.js";
import type { TurnWatchdog } from "./turn-watchdog.js";

type TurnSenderDeps = {
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
	/** 当前会话有回合在跑时的排队 / 插队处理；返回 null = 没接住，继续走正常发送 */
	busy: (
		mode: SendMode,
		text: string,
		promptText: string,
		images: Array<{ data: string; mimeType: string }>,
		/** 这条消息要去的会话（忙碌判断 / 排队都按它，不看全局 activeId） */
		conversationId: string,
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
	clientView: {
		setActive: (clientId: string, conversationId: string) => void;
		/** 这个客户端自己在看哪个会话（null = 它没有会话；回落到全局 activeId 只在没有 clientId 时） */
		activeFor: (clientId: string | undefined, fallback: string | null) => string | null;
	};
	touchConversation: (conversationId: string, patch?: { title?: string }) => void;
	/**
	 * 回合进行中到了「一步结束」（一次工具调用结束 / 一次模型调用收尾）时回调。
	 * 挂着的插队就靠它注入：这正是引擎自己插队的时机（见 createTurnPlumbing 的 flushSteer）。
	 */
	steerAtBoundary?: (conversationId: string) => void;
	uploadStore?: { read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null> };
};

export function createTurnSender(deps: TurnSenderDeps) {
	const { state } = deps;
	/**
	 * 「还没有会话 → 懒建一个」这一步是异步的（要落盘 + 起引擎会话），期间 `state.activeId`
	 * 仍然是空的：**两下点击会各建一个会话**（手机上加倍容易触发双击）。
	 * 所以按发起者合并并发的新建请求：同一个人连点两下只建一个；不同客户端各建各的。
	 */
	const creating = new Map<string, Promise<string>>();
	const conversationKey = (clientId: string | undefined) => clientId ?? "__global__";
	const ensureConversation = (key: string, text: string): Promise<string> => {
		const pending = creating.get(key);
		if (pending) return pending;
		const task = deps.createConversation(text).finally(() => creating.delete(key));
		creating.set(key, task);
		return task;
	};

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

		/**
		 * 「这条消息发到哪个会话」按**这个客户端自己的视图**算（ADR-0033），不再用全局
		 * `state.activeId` —— 否则手机（自己的视图还是空的）一发消息就跑进电脑上那个会话里，
		 * 界面上看着像「点了没反应」。
		 *
		 * 而且必须在**忙碌判断之前**算出来：判断「这一轮在不在跑」得看这条消息**真正要去的会话**。
		 * 以前先看 `state.activeId`（它只是全局「最近操作过的会话」，见 client-view 的纪律），于是只要
		 * 目标会话在跑、全局值指向另一个会话（多标签 / 多设备 / 切引擎后是 null），守卫就被整个跳过 ——
		 * 消息直接进引擎，pi 回一句 `Agent is already processing`，界面上就是一条 `engine.prompt_failed`
		 * 红条（用户报的 bug）。同一个根因的另一面更隐蔽：守卫就算命中了，排队也排进 `state.activeId`
		 * 那个会话（`busy` 以前用 `deps.activeId()`），这一轮结束后被发去**别的会话**。
		 */
		const own = clientId ? deps.clientView.activeFor(clientId, state.activeId) : state.activeId;
		const existing = targetConversationId ?? own ?? null;
		if (existing !== null && deps.turns.has(existing)) {
			const handled = await deps.busy(mode, text, resolved.promptText, resolved.images, existing, attachments);
			if (handled) return handled;
		}

		let conversationId: string | null = null;
		let failed = false;
		try {
			const created = existing ? null : await ensureConversation(conversationKey(clientId), text);
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

			/**
			 * 二次忙碌检查（并发双发的唯一正确闭合点）。
			 *
			 * 上面的守卫只能看到「发消息这一刻」turns 里有没有条目。但会话刚建出来（`existing === null`）时，
			 * 两条并发 `send_message` 会**都**走过守卫：`ensureConversation` 把它们合并成同一个会话 id，
			 * 然后各自 await 打开会话/刷新模型 —— 等到真正落消息时 turns 已经被对方占住了。
			 * 结果是用户消息重复、两个 assistant 消息 id 互相覆盖（旧的那条永远等不到 turn_end）。
			 *
			 * 位置很关键：这里往下到 `deps.turns.set` **没有任何 await**，全程同步。
			 * JS 单线程 ⇒ 谁先跑过这段谁就占住 turns，后到的必然看到 `turns.has(conv) === true`。
			 */
			if (deps.turns.has(conv)) {
				const handled = await deps.busy(mode, text, resolved.promptText, resolved.images, conv, attachments);
				if (handled) return handled;
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
					retrying: null,
				};
				state.running = running;
			}
			setActionsOf(state, conv, []);
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
					// 插队挂着的时候：一到「一步结束」就插进去（tool_end / 一次模型调用收尾）
					if (event.type === "tool_end" || (event.type === "usage" && event.final === true)) {
						deps.steerAtBoundary?.(conv);
					}
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
