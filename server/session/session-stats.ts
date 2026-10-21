/**
 * 会话统计（顶部「会话信息」用）：直接解析 pi 的会话 JSONL。
 *
 * 为什么从这里算而不是从内存事件累加：会话可能是**在 pi CLI 里开的**（ADR-0021），
 * 或者是上次进程留下的历史。JSONL 是唯一的事实源，内存里没有那些轮的 usage。
 *
 * 只读、有上限（20MB）：一个会话文件不该把服务端读卡。
 */
import { readFile, stat } from "node:fs/promises";
import type { SessionStats } from "../protocol.js";
import { parseUsage } from "../util/usage.js";

export const MAX_STATS_BYTES = 20 * 1024 * 1024;

export type { SessionStats } from "../protocol.js";

export function emptyStats(): SessionStats {
	return {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		contextTokens: 0,
	};
}

/** 纯函数：把若干行 JSONL 文本聚合成统计（坏行跳过，绝不抛） */
export function summarizeSession(lines: string[]): SessionStats {
	const stats = emptyStats();
	for (const line of lines) {
		if (line.trim() === "") continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const message = (record.message ?? record) as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "";
		if (role === "user") stats.userMessages += 1;
		else if (role === "assistant") stats.assistantMessages += 1;
		else if (role === "toolResult" || role === "tool") stats.toolResults += 1;
		else continue; // header / 其它事件不计
		stats.totalMessages += 1;

		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall")
					stats.toolCalls += 1;
			}
		}

		if (role === "assistant") {
			// 字段名各家不一样 → 统一口径解析（server/util/usage.ts）
			const usage = parseUsage(message.usage);
			if (usage) {
				stats.inputTokens += usage.input;
				stats.outputTokens += usage.output;
				stats.cacheRead += usage.cacheRead;
				stats.cacheWrite += usage.cacheWrite;
				// 最近一条 assistant 的输入侧大小 ≈ 当前上下文占用
				stats.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			}
		}
	}
	stats.totalTokens = stats.inputTokens + stats.outputTokens + stats.cacheRead + stats.cacheWrite;
	return stats;
}

/** 读一个会话文件并聚合；文件不存在 / 过大都返回 null（界面显示"未知"即可） */
export async function readSessionStats(sessionPath: string | null): Promise<SessionStats | null> {
	if (!sessionPath) return null;
	try {
		const info = await stat(sessionPath);
		if (!info.isFile() || info.size > MAX_STATS_BYTES) return null;
		const text = await readFile(sessionPath, "utf8");
		return summarizeSession(text.split("\n"));
	} catch {
		return null;
	}
}
