/**
 * 转录落盘：每会话一个**追加写** JSONL（ADR-0005）。
 *
 * 文件格式（`<dataDir>/conversations/<id>.jsonl`）：
 *   第 1 行  {"v":1,"kind":"meta","id":"…","workspace":"…","createdAt":123,"title":"…"}
 *   随后每行：{"kind":"message","id":"…","role":"user|assistant","ts":123,"blocks":[…]}
 *            {"kind":"title","title":"新标题","ts":123}        ← 改名事件（避免重写整个文件）
 *
 * 为什么只追加：崩溃最多丢「最后一行」（甚至是半行）——这是结构性质，不需要事务。
 * 读取时的容错（ADR-0005 守卫 1）：**跳过解析失败的行**，特别是末尾的半行。
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMeta, UiMessage } from "../protocol.js";

export const FORMAT_VERSION = 1;
export const CONVERSATIONS_DIR = "conversations";

export type TranscriptMeta = { v: number; id: string; workspace: string; createdAt: number; title: string };

export type ParsedTranscript = {
	meta: TranscriptMeta | null;
	messages: UiMessage[];
	/** 文件里最后一条 title 事件（改名用） */
	title: string | null;
	/** 无法解析/不认识的行数（含末尾半行） */
	skipped: number;
	/** 末尾那一行是不是坏的（＝崩溃残留的半行） */
	skippedTail: boolean;
};

export function conversationsDir(dataDir: string): string {
	return join(dataDir, CONVERSATIONS_DIR);
}

export function conversationFile(dataDir: string, conversationId: string): string {
	return join(conversationsDir(dataDir), `${conversationId}.jsonl`);
}

export function metaLine(meta: TranscriptMeta): string {
	return JSON.stringify({ ...meta, v: FORMAT_VERSION, kind: "meta" });
}

export function messageLine(message: UiMessage): string {
	return JSON.stringify({ kind: "message", ...message });
}

export function titleLine(title: string, ts: number): string {
	return JSON.stringify({ kind: "title", title, ts });
}

function isUiMessage(value: unknown): value is UiMessage {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		(candidate.role === "user" || candidate.role === "assistant") &&
		typeof candidate.ts === "number" &&
		Array.isArray(candidate.blocks)
	);
}

/** 纯函数：把一份 jsonl 文本解析成转录（坏行跳过，不抛） */
export function parseTranscript(text: string): ParsedTranscript {
	const result: ParsedTranscript = { meta: null, messages: [], title: null, skipped: 0, skippedTail: false };
	const lines = text.split("\n");
	// 末尾的空串不算「坏行」（正常文件也以 \n 结尾）
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	lines.forEach((line, index) => {
		const isLast = index === lines.length - 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			result.skipped += 1;
			if (isLast) result.skippedTail = true;
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			result.skipped += 1;
			if (isLast) result.skippedTail = true;
			return;
		}

		const record = parsed as Record<string, unknown>;
		if (record.kind === "meta") {
			result.meta = {
				v: typeof record.v === "number" ? record.v : FORMAT_VERSION,
				id: String(record.id ?? ""),
				workspace: String(record.workspace ?? ""),
				createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
				title: String(record.title ?? ""),
			};
			return;
		}
		if (record.kind === "title") {
			if (typeof record.title === "string") result.title = record.title;
			else result.skipped += 1;
			return;
		}
		// `kind: "message"` 是标准写法；同时容忍「一行一条消息」不带 kind 的写法（ADR-0005 的字面口径）
		const candidate = record.kind === "message" ? { ...record, kind: undefined } : record;
		if (isUiMessage(candidate)) {
			result.messages.push({
				id: candidate.id,
				role: candidate.role,
				ts: candidate.ts,
				blocks: candidate.blocks,
			});
			return;
		}
		result.skipped += 1;
		if (isLast) result.skippedTail = true;
	});

	return result;
}

/** 由转录算出会话元数据（索引重建与读取共用，纯函数） */
export function metaFromTranscript(conversationId: string, parsed: ParsedTranscript): ConversationMeta {
	const firstUserMessage = parsed.messages.find((message) => message.role === "user");
	const lastTs = parsed.messages.reduce((max, message) => Math.max(max, message.ts), 0);
	const title = parsed.title ?? parsed.meta?.title ?? "";
	return {
		id: conversationId,
		title: title !== "" ? title : deriveTitle(messageTextOf(firstUserMessage)),
		createdAt: parsed.meta?.createdAt ?? parsed.messages[0]?.ts ?? 0,
		updatedAt: lastTs > 0 ? lastTs : (parsed.meta?.createdAt ?? 0),
		workspace: parsed.meta?.workspace ?? "",
		messageCount: parsed.messages.length,
	};
}

function messageTextOf(message: UiMessage | undefined): string {
	if (!message) return "";
	return message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("")
		.trim();
}

/** 标题规则：首条用户消息的第一行，截断到 n 字（ADR-0005） */
export function deriveTitle(text: string, maxChars = 24): string {
	const firstLine = (text.split("\n")[0] ?? "").trim();
	if (firstLine === "") return "新对话";
	return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
	await mkdir(conversationsDir(dataDir), { recursive: true });
}

export async function createTranscript(dataDir: string, meta: TranscriptMeta): Promise<void> {
	await ensureDataDirs(dataDir);
	await appendFile(conversationFile(dataDir, meta.id), `${metaLine(meta)}\n`, "utf8");
}

export async function appendMessage(dataDir: string, conversationId: string, message: UiMessage): Promise<void> {
	await appendFile(conversationFile(dataDir, conversationId), `${messageLine(message)}\n`, "utf8");
}

export async function appendTitle(dataDir: string, conversationId: string, title: string, ts: number): Promise<void> {
	await appendFile(conversationFile(dataDir, conversationId), `${titleLine(title, ts)}\n`, "utf8");
}

export type ReadTranscriptResult = ParsedTranscript & { exists: boolean };

export async function readTranscript(dataDir: string, conversationId: string): Promise<ReadTranscriptResult> {
	try {
		const text = await readFile(conversationFile(dataDir, conversationId), "utf8");
		return { ...parseTranscript(text), exists: true };
	} catch {
		return { meta: null, messages: [], title: null, skipped: 0, skippedTail: false, exists: false };
	}
}

export async function listTranscriptIds(dataDir: string): Promise<string[]> {
	try {
		const entries = await readdir(conversationsDir(dataDir));
		return entries
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => name.slice(0, -".jsonl".length))
			.sort();
	} catch {
		return [];
	}
}
