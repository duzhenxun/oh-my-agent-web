/**
 * 把引擎事件翻译成 UI 状态（ADR-0012 的消息块 / ADR-0004 的增量推送）。
 *
 * 从 runtime 拆出来（ADR-0010 的 400 行护栏第五次咬人）：这是「翻译层」，
 * 与「谁在跑、怎么落盘、谁先谁后」无关 —— 后者留在 runtime。
 *
 * 规则（都来自既有 ADR）：
 *   - 正文只走 `message_delta` 增量，**不**每字推快照（ADR-0004 §3）；
 *   - 工具卡与错误块是**结构性变化** → 推快照（ADR-0012）；
 *   - 工具输出超限截断（ADR-0004 §5，由 finishTool 内部处理）；
 *   - 错误写进转录 + 一条 notice（ADR-0013：失败必须留在历史里）。
 */
import type { Notice, ServerEvent, UiMessage } from "../protocol.js";
import type { EngineEvent } from "../engine/port.js";
import type { ServerState } from "../snapshot/state.js";
import { appendError, appendText, appendThinking, finishTool, startTool } from "../snapshot/messages.js";
import { scheduledCost } from "../util/pricing-index.js";

/** 思考计时：messageId → 这一段思考的起点（跨事件累计，最后落成 message.thinkingMs） */
const thinkingSince = new Map<string, number>();

export type TurnEventContext = {
	state: ServerState;
	now: () => number;
	/** 推一条协议事件（正文增量 / notice） */
	emitEvent: (event: ServerEvent) => void;
	pushSnapshot: () => void;
	/**
	 * 推一条提示。参数顺序与提示牌一致：`key` 是「同 key 原地替换」，
	 * `conversationId` 是「这条属于哪个会话」（见 Notice.conversationId）。
	 * 两个都是字符串，**别搞混位置**：传错位就成了「按会话 id 去重」。
	 */
	notice: (text: string, level?: Notice["level"], key?: string, conversationId?: string) => void;
	/**
	 * 正文增量处理（ADR-0022）：runtime 在这里累积**原始文本**（供回合结束解析建议），
	 * 并返回**可以显示的部分**（把可能是 [[action:...]] 开头的内容扣住）。
	 */
	onTextDelta: (chunk: string, conversationId: string) => string;
	/** 思考增量到达（runtime 负责节流推快照，避免每个 token 都推一帧） */
	onThinkingDelta?: (conversationId: string) => void;
	/** 回合结束（done / interrupted / error）：由 runtime 负责落盘与状态收尾 */
	onTurnEnd: (conversationId: string, reason: "done" | "interrupted" | "error") => void;
};

/**
 * 组装「事件 → 状态」的上下文（从 runtime 抽出来，省下十来行装配代码）。
 * runtime 只提供三件事：原始文本累积、事件出口、回合收尾。
 */
export function createTurnContext(options: {
	state: ServerState;
	now: () => number;
	pushSnapshot: () => void;
	emitEvent: (event: ServerEvent) => void;
	/** `conversationId` = 这条提示属于哪个会话（见 Notice.conversationId） */
	notice: (text: string, level?: Notice["level"], conversationId?: string) => void;
	/** 思考增量节流后的推帧（runtime 注入 createThrottle 的结果） */
	onThinkingDelta: (conversationId: string) => void;
	/** 原始正文累积并返回可显示部分（ADR-0022 的标记扣留） */
	appendRawText: (chunk: string, conversationId: string) => string;
	/** 回合结束：落盘 + 状态收尾（runtime 负责） */
	finish: (conversationId: string, reason: "done" | "interrupted" | "error") => void;
}): TurnEventContext {
	return {
		state: options.state,
		now: options.now,
		pushSnapshot: options.pushSnapshot,
		emitEvent: options.emitEvent,
		notice: options.notice,
		onThinkingDelta: options.onThinkingDelta,
		onTextDelta: options.appendRawText,
		onTurnEnd: options.finish,
	};
}

type TurnEventInput = {
	conversationId: string;
	messageId: string;
	event: EngineEvent;
};

export function applyEngineEvent(context: TurnEventContext, input: TurnEventInput): void {
	const { conversationId, messageId, event } = input;
	const { state } = context;

	const patch = (change: (message: UiMessage) => UiMessage) => {
		const list = state.messages[conversationId] ?? [];
		state.messages[conversationId] = list.map((message) => (message.id === messageId ? change(message) : message));
	};

	/** 结束这一段思考计时，把毫秒累到消息上（thinkingMs） */
	const closeThinking = () => {
		const since = thinkingSince.get(messageId);
		if (since === undefined) return;
		thinkingSince.delete(messageId);
		const span = Math.max(0, context.now() - since);
		if (span <= 0) return;
		patch((message) => ({ ...message, thinkingMs: (message.thinkingMs ?? 0) + span }));
	};

	if (event.type !== "thinking_delta") closeThinking();

	switch (event.type) {
		case "text_delta": {
			const visible = context.onTextDelta(event.text, conversationId);
			if (visible === "") return; // 抠住了（可能在写标记）
			patch((message) => appendText(message, visible));
			if (conversationId === state.activeId) state.running.streamingText += visible;
			context.emitEvent({ type: "event", event: "message_delta", conversationId, messageId, text: visible });
			return;
		}
		case "thinking_delta": {
			if (!thinkingSince.has(messageId)) thinkingSince.set(messageId, context.now());
			patch((message) => appendThinking(message, event.text));
			context.onThinkingDelta?.(conversationId);
			return;
		}
		case "model": {
			// 每条回复记下自己用的模型（历史/对照时不受「当前选择」影响）
			patch((message) => ({ ...message, model: event.model }));
			return;
		}
		case "usage": {
			// 过程值不算（final:false）：同一轮里每调一次模型都会有一份最终值，
			// 全部**累加**才是这一轮的真实开销 —— 以前是覆盖，只剩最后一次调用的数字。
			if (event.final === false) return;
			patch((message) => {
				const previous = message.usage;
				// 分时价格（ADR-0026 D 期）：模型配了时段表就按「这次调用发生的时刻」算钱，
				// 引擎给的 cost 只是兜底（厂商的分时价 pi 根本不知道，混着算只会更错）。
				// 用增量而不是总额：一轮里跨过时段边界也能各算各的。
				const scheduled = scheduledCost(
					message.model ?? state.model,
					{ input: event.input, output: event.output, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite },
					context.now(),
				);
				const delta = scheduled ?? event.cost;
				// 只有真的拿到过价格才给：拿不到就别编一个 0 出来
				const cost =
					previous?.cost === undefined && delta === undefined ? undefined : (previous?.cost ?? 0) + (delta ?? 0);
				return {
					...message,
					usage: {
						input: (previous?.input ?? 0) + event.input,
						output: (previous?.output ?? 0) + event.output,
						cacheRead: (previous?.cacheRead ?? 0) + event.cacheRead,
						cacheWrite: (previous?.cacheWrite ?? 0) + event.cacheWrite,
						...(cost === undefined ? {} : { cost }),
					},
				};
			});
			return;
		}
		case "tool_start": {
			patch((message) =>
				startTool(message, {
					toolCallId: event.toolCallId,
					name: event.name,
					argsSummary: event.argsSummary,
					argsFull: event.argsFull,
					startedAt: context.now(),
				}),
			);
			state.running.activeTool = { name: event.name, argsSummary: event.argsSummary, startedAt: context.now() };
			context.pushSnapshot();
			return;
		}
		case "tool_end": {
			patch((message) =>
				finishTool(message, {
					toolCallId: event.toolCallId,
					status: event.status,
					output: event.output,
					endedAt: context.now(),
					...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
				}),
			);
			state.running.activeTool = null;
			context.pushSnapshot();
			return;
		}
		case "error": {
			patch((message) => appendError(message, event.code, event.message));
			state.running.status = "error";
			context.notice(`${event.code}: ${event.message}`, "error", undefined, conversationId);
			return;
		}
		case "turn_end": {
			context.onTurnEnd(conversationId, event.reason);
			return;
		}
	}
}
