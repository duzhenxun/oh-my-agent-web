/**
 * 会话索引：`<dataDir>/sessions.json`（ADR-0005 §2）。
 *
 * 两条硬要求：
 *   1. **必须可重建** —— 索引坏了/删了，从 `conversations/*.jsonl` 全量扫一遍就能恢复；
 *   2. 写索引要**原子**（临时文件 + rename）—— 它是整体重写，不像转录那样只追加。
 *
 * 索引只是「列表页的缓存」，不是事实源；事实源永远是转录文件。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationMeta } from "../protocol.js";
import { listTranscriptIds, metaFromTranscript, readTranscript } from "./jsonl-store.js";

export const INDEX_FILE = "sessions.json";
export const INDEX_VERSION = 1;

export type IndexFile = { v: number; conversations: ConversationMeta[] };

export function indexPath(dataDir: string): string {
	return join(dataDir, INDEX_FILE);
}

function isMeta(value: unknown): value is ConversationMeta {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.title === "string" &&
		typeof candidate.createdAt === "number" &&
		typeof candidate.updatedAt === "number" &&
		typeof candidate.messageCount === "number"
	);
}

/** 纯函数：解析索引文件；形状不对就返回 null（调用方据此重建） */
export function parseIndex(text: string): ConversationMeta[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const conversations = (parsed as Record<string, unknown>).conversations;
	if (!Array.isArray(conversations) || !conversations.every(isMeta)) return null;
	return conversations.map((meta) => ({ ...meta }));
}

export async function writeIndex(dataDir: string, conversations: ConversationMeta[]): Promise<void> {
	const target = indexPath(dataDir);
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.tmp`;
	const payload: IndexFile = { v: INDEX_VERSION, conversations: conversations.map((meta) => ({ ...meta })) };
	await writeFile(temporary, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
	await rename(temporary, target); // 原子替换：不会留下半个索引
}

export async function readIndex(dataDir: string): Promise<ConversationMeta[] | null> {
	try {
		return parseIndex(await readFile(indexPath(dataDir), "utf8"));
	} catch {
		return null;
	}
}

/** 从转录文件全量重建索引（纯 I/O，不写盘） */
export async function rebuildFromTranscripts(dataDir: string): Promise<ConversationMeta[]> {
	const ids = await listTranscriptIds(dataDir);
	const metas: ConversationMeta[] = [];
	for (const id of ids) {
		const transcript = await readTranscript(dataDir, id);
		if (!transcript.exists) continue;
		metas.push(metaFromTranscript(id, transcript));
	}
	return metas.sort((a, b) => a.createdAt - b.createdAt);
}

export type LoadIndexResult = {
	conversations: ConversationMeta[];
	rebuilt: boolean;
};

/**
 * 读取索引；缺失或损坏时重建并写回。
 * `rebuilt: true` 会让启动日志多一行 —— 这条信息在排查「会话怎么少了」时很关键。
 */
export async function loadOrRebuildIndex(dataDir: string): Promise<LoadIndexResult> {
	const existing = await readIndex(dataDir);
	if (existing) return { conversations: existing, rebuilt: false };
	const conversations = await rebuildFromTranscripts(dataDir);
	await writeIndex(dataDir, conversations);
	return { conversations, rebuilt: true };
}

export async function removeIndex(dataDir: string): Promise<void> {
	await rm(indexPath(dataDir), { force: true });
}
