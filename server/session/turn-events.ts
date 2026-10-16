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
import { appendError, appendText, finishTool, startTool } from "../snapshot/messages.js";

export type TurnEventContext = {
	state: ServerState;
	now: () => number;
	/** 推一条协议事件（正文增量 / notice） */
	emitEvent: (event: ServerEvent) => void;
	pushSnapshot: () => void;
	notice: (text: string, level?: Notice["level"]) => void;
	/** 回合结束（done / interrupted / error）：由 runtime 负责落盘与状态收尾 */
	onTurnEnd: (conversationId: string, reason: "done" | "interrupted" | "error") => void;
};

export type TurnEventInput = {
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

	switch (event.type) {
		case "text_delta": {
			patch((message) => appendText(message, event.text));
			state.running.streamingText += event.text;
			context.emitEvent({ type: "event", event: "message_delta", conversationId, messageId, text: event.text });
			return;
		}
		case "tool_start": {
			patch((message) =>
				startTool(message, {
					toolCallId: event.toolCallId,
					name: event.name,
					argsSummary: event.argsSummary,
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
			context.notice(`${event.code}: ${event.message}`, "error");
			return;
		}
		case "turn_end": {
			context.onTurnEnd(conversationId, event.reason);
			return;
		}
	}
}
