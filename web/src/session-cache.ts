/**
 * 会话正文的**浏览器本地缓存**（ADR-0012 的唯一事实源不变：缓存永远只是「预览」）。
 *
 * 为什么要有：会话第一次打开时，服务端要读 JSONL、整理成消息，再把整份快照推过来
 * （几百 KB）。在手机上/外网就是一两秒的空白，看着像「点了没反应」。
 * 已经看过一次的会话，浏览器里留一份正文：再点开先拿它立刻铺满屏幕，
 * 服务端快照到了就覆盖掉 —— 首屏不用等网络。
 *
 * 为什么用 IndexedDB：一份正文可能几百 KB，localStorage 总共才 ~5MB，
 * 而且是同步写，会卡主线程。IndexedDB 是异步、配额大，还能按时间清理。
 *
 * 失败一律「当作没有缓存」（隐私模式 / 配额满 / 老浏览器），不影响正常流程。
 */
import type { UiMessage } from "./types.ts";

const DB_NAME = "agent-web-cache";
const DB_VERSION = 1;
const STORE = "transcripts";
/** 最多留多少个会话的正文（按 savedAt 淘汰最旧的） */
const MAX_ENTRIES = 40;
/** 单条估算上限：超了就不缓存（巨型会话别把配额吃光） */
const MAX_ESTIMATED_BYTES = 3 * 1024 * 1024;

type Entry = { id: string; savedAt: number; messages: UiMessage[] };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	dbPromise ??= new Promise((resolve) => {
		if (typeof indexedDB === "undefined") {
			resolve(null);
			return;
		}
		try {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (db.objectStoreNames.contains(STORE)) return;
				const store = db.createObjectStore(STORE, { keyPath: "id" });
				// 按时间清理要用它
				store.createIndex("savedAt", "savedAt");
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return dbPromise;
}

/** 粗估一份正文有多大（不序列化：序列化本身就要几十毫秒，得不偿失） */
function estimateBytes(messages: UiMessage[]): number {
	let bytes = 0;
	for (const message of messages) {
		bytes += 120; // 消息本身的骨架
		for (const block of message.blocks) {
			if (block.kind === "text" || block.kind === "thinking") bytes += block.text.length * 2;
			else bytes += 240;
		}
	}
	return bytes;
}

/** 读缓存：没有（或读不了）就是 null */
export async function readCachedMessages(conversationId: string): Promise<UiMessage[] | null> {
	const db = await openDb();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const request = db.transaction(STORE, "readonly").objectStore(STORE).get(conversationId);
			request.onsuccess = () => {
				const entry = request.result as Entry | undefined;
				resolve(entry && Array.isArray(entry.messages) && entry.messages.length > 0 ? entry.messages : null);
			};
			request.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/** 写缓存：顺带按 MAX_ENTRIES 淘汰最旧的；空会话不写 */
export async function writeCachedMessages(conversationId: string, messages: UiMessage[]): Promise<void> {
	if (messages.length === 0) return;
	if (estimateBytes(messages) > MAX_ESTIMATED_BYTES) {
		await forgetCachedMessages(conversationId);
		return;
	}
	const db = await openDb();
	if (!db) return;
	const entry: Entry = { id: conversationId, savedAt: Date.now(), messages };
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			store.put(entry);
			// 淘汰：按 savedAt 从新到旧数够 MAX_ENTRIES 个，后面的删掉
			let seen = 0;
			store.index("savedAt").openCursor(null, "prev").onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (!cursor) return;
				seen += 1;
				if (seen > MAX_ENTRIES) cursor.delete();
				cursor.continue();
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}

/** 丢掉某个会话的缓存（删会话时跟着清） */
export async function forgetCachedMessages(conversationId: string): Promise<void> {
	const db = await openDb();
	if (!db) return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete(conversationId);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}
