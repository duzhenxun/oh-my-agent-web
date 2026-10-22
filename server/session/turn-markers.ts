/**
 * 回合结束时的标记收尾（ADR-0022）：从 runtime 拆出（400 行护栏第六次咬人）。
 *
 * 两件事：
 *   1. 把流式过滤器里还扣着的尾巴放出来（此时它已经不可能是标记）；
 *   2. 对最终的助手文本做完整解析：剥离标记 → 建议项进快照。
 */
import { applyMarkersToMessage, reduceActionMarkers } from "../markers/actions.js";
import type { ActionItem, UiMessage } from "../protocol.js";

export type TurnMarkersInput = {
	state: { messages: Record<string, UiMessage[]>; actions: ActionItem[] };
	conversationId: string;
	messageId: string;
	/** 本回合的**原始**文本（含标记）：建议必须从它里面解析 —— 流式过滤器已经把标记丢了 */
	rawText: string;
	nextId: (prefix: string) => string;
	/** 回合结束的时间（毫秒）：写进助手消息的 `endedAt`，界面显示它而不是开始时间 */
	at?: number;
};

export function settleTurnMarkers(input: TurnMarkersInput): void {
	const { state, conversationId, messageId } = input;

	// 1) 建议从**原始文本**里收（ADR-0022）：流式过滤器为了不漏语法已经把标记丢掉了，
	//    所以回合结束必须回看原始文本，否则建议永远收不到。
	const reduced = reduceActionMarkers(input.rawText, state.actions, () => input.nextId("act"));
	state.actions = reduced.actions;

	// 2) 消息正文收尾：剥掉可能漏网的标记 + 收拾残留空行（applyMarkersToMessage 是幂等的）
	const assistant = (state.messages[conversationId] ?? []).find((message) => message.id === messageId);
	if (!assistant) return;
	const applied = applyMarkersToMessage(assistant, state.actions, () => input.nextId("act"));
	state.actions = applied.actions;
	const endedAt = input.at ?? Date.now();
	const blocksChanged = applied.blocks !== assistant.blocks;
	if (blocksChanged || assistant.endedAt !== endedAt) {
		state.messages[conversationId] = (state.messages[conversationId] ?? []).map((message) =>
			message.id === messageId ? { ...message, blocks: applied.blocks, endedAt } : message,
		);
	}
}
