/**
 * 流式正文的本地追加。
 *
 * 为什么前端也要有一份「追加文本」的逻辑：正文走 message_delta 增量（ADR-0004 §3），
 * 客户端必须能就地更新，不能每字等一次快照。
 * 这里与 `server/snapshot/messages.ts` 的 appendText 是**同一规则的两处实现**，
 * 单测 `tests/unit/delta.test.ts` 锁住两者的行为一致性（服务端那份在会话落盘测试里也会被间接覆盖）。
 */
import type { MessageBlock, UiMessage } from "../types.ts";

export function appendTextToMessage(message: UiMessage, text: string): UiMessage {
	const blocks: MessageBlock[] = [...message.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + text };
	else blocks.push({ kind: "text", text });
	return { ...message, blocks };
}
