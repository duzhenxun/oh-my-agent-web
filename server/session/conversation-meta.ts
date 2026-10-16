/**
 * 会话元数据的维护助手（从 runtime 拆出，ADR-0010 的 400 行护栏第五次咬人）。
 *
 * 都是「改 state 上的会话列表」这类重复的小动作，抽出来后 runtime 只描述流程，
 * 而这些动作可以单独测（比如「消息数会不会跟着更新」）。
 */
import type { ConversationMeta, UiMessage } from "../protocol.js";
import type { ConversationStore } from "./store.js";

export function updateConversationMeta(
	state: { conversations: ConversationMeta[]; messages: Record<string, UiMessage[]> },
	conversationId: string,
	now: number,
): void {
	state.conversations = state.conversations.map((conversation) =>
		conversation.id === conversationId
			? { ...conversation, updatedAt: now, messageCount: state.messages[conversationId]?.length ?? 0 }
			: conversation,
	);
}

export function renameConversation(
	state: { conversations: ConversationMeta[] },
	conversationId: string,
	title: string,
): void {
	state.conversations = state.conversations.map((conversation) =>
		conversation.id === conversationId ? { ...conversation, title } : conversation,
	);
}

/** 落索引：失败只警告（索引不是事实源，可从转录重建，见 ADR-0005 §2） */
export async function persistIndexSafely(
	store: ConversationStore,
	conversations: ConversationMeta[],
	onError: (message: string) => void,
): Promise<void> {
	try {
		await store.saveIndex(conversations);
	} catch (error) {
		onError(`索引写入失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 把会话消息从存储读进内存（幂等）；坏行数交给调用方提示 */
export async function loadConversationMessages(
	store: ConversationStore,
	state: { messages: Record<string, UiMessage[]> },
	loaded: Set<string>,
	conversationId: string,
	onSkipped: (message: string) => void,
): Promise<void> {
	if (loaded.has(conversationId)) return;
	const { messages, skipped } = await store.readMessages(conversationId);
	state.messages[conversationId] = messages;
	loaded.add(conversationId);
	if (skipped > 0) onSkipped(`会话 ${conversationId} 有 ${skipped} 行无法解析，已跳过（转录其余部分正常）`);
}
