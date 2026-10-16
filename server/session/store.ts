/**
 * 会话存储门面（ADR-0005）。
 *
 * 两种实现：
 *   - `createJsonlStore(dataDir)` —— 真实落盘：追加写 jsonl + 原子写索引 + 可重建；
 *   - `createMemoryStore()`       —— 内存版：单测用，行为与落盘版一致（同一套接口）。
 *
 * 为什么要门面：runtime 只依赖这个接口，于是「持久化是否正确」可以用纯单测覆盖，
 * 而不必在每次会话逻辑测试里都去碰文件系统。
 */
import type { ConversationMeta, UiMessage } from "../protocol.js";
import {
	appendMessage as appendMessageToFile,
	appendTitle,
	createTranscript,
	deriveTitle,
	ensureDataDirs,
	readTranscript,
} from "./jsonl-store.js";
import { loadOrRebuildIndex, writeIndex } from "./index-store.js";

export type StoreInitResult = {
	conversations: ConversationMeta[];
	/** 索引缺失/损坏而被重建（启动日志会记一行） */
	rebuilt: boolean;
};

export type ReadMessagesResult = {
	messages: UiMessage[];
	skipped: number;
	skippedTail: boolean;
};

export type ConversationStore = {
	init(): Promise<StoreInitResult>;
	create(input: { id: string; title: string; workspace: string; now: number }): Promise<void>;
	appendMessage(conversationId: string, message: UiMessage): Promise<void>;
	readMessages(conversationId: string): Promise<ReadMessagesResult>;
	rename(conversationId: string, title: string, ts: number): Promise<void>;
	saveIndex(conversations: ConversationMeta[]): Promise<void>;
};

export function createJsonlStore(dataDir: string): ConversationStore {
	return {
		async init() {
			await ensureDataDirs(dataDir);
			const { conversations, rebuilt } = await loadOrRebuildIndex(dataDir);
			return { conversations, rebuilt };
		},

		async create(input) {
			await createTranscript(dataDir, {
				v: 1,
				id: input.id,
				workspace: input.workspace,
				createdAt: input.now,
				title: input.title,
			});
		},

		async appendMessage(conversationId, message) {
			await appendMessageToFile(dataDir, conversationId, message);
		},

		async readMessages(conversationId) {
			const transcript = await readTranscript(dataDir, conversationId);
			return { messages: transcript.messages, skipped: transcript.skipped, skippedTail: transcript.skippedTail };
		},

		async rename(conversationId, title, ts) {
			await appendTitle(dataDir, conversationId, title, ts);
		},

		async saveIndex(conversations) {
			await writeIndex(dataDir, conversations);
		},
	};
}

export function createMemoryStore(seed?: {
	conversations?: ConversationMeta[];
	messages?: Record<string, UiMessage[]>;
}): ConversationStore {
	const transcripts = new Map<string, UiMessage[]>();
	const titles = new Map<string, string>();
	const metas = new Map<string, ConversationMeta>();

	for (const meta of seed?.conversations ?? []) metas.set(meta.id, { ...meta });
	for (const [id, messages] of Object.entries(seed?.messages ?? {})) transcripts.set(id, [...messages]);

	return {
		async init() {
			return { conversations: [...metas.values()].sort((a, b) => a.createdAt - b.createdAt), rebuilt: false };
		},

		async create(input) {
			transcripts.set(input.id, []);
			metas.set(input.id, {
				id: input.id,
				title: input.title,
				createdAt: input.now,
				updatedAt: input.now,
				workspace: input.workspace,
				messageCount: 0,
			});
		},

		async appendMessage(conversationId, message) {
			const list = transcripts.get(conversationId) ?? [];
			// 与服务端行为一致：同一 id 重复写入时覆盖（回合结束才落助手消息）
			const index = list.findIndex((item) => item.id === message.id);
			if (index >= 0) list[index] = message;
			else list.push(message);
			transcripts.set(conversationId, list);
		},

		async readMessages(conversationId) {
			return { messages: [...(transcripts.get(conversationId) ?? [])], skipped: 0, skippedTail: false };
		},

		async rename(conversationId, title) {
			titles.set(conversationId, title);
		},

		async saveIndex(conversations) {
			for (const meta of conversations) metas.set(meta.id, { ...meta });
		},
	};
}

export { deriveTitle };
