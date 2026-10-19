/**
 * 会话统计（顶部会话信息）：从 pi 的 JSONL 聚合 token 与消息数。
 */
import { describe, expect, it } from "vitest";
import { emptyStats, summarizeSession } from "../../server/session/session-stats.js";

const lines = [
	JSON.stringify({ type: "header", cwd: "/tmp/x" }),
	JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "你好" }] } }),
	JSON.stringify({
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "在的" },
				{ type: "toolCall", name: "bash" },
			],
			usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 },
		},
	}),
	JSON.stringify({ message: { role: "toolResult", content: [] } }),
	JSON.stringify({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: { input: 50, output: 10, cache_read: 950 },
		},
	}),
];

describe("summarizeSession", () => {
	it("数消息、工具调用与 token（兼容 inputTokens / input / cache_read 几种写法）", () => {
		const stats = summarizeSession(lines);
		expect(stats.userMessages).toBe(1);
		expect(stats.assistantMessages).toBe(2);
		expect(stats.toolResults).toBe(1);
		expect(stats.toolCalls).toBe(1);
		expect(stats.totalMessages).toBe(4);
		expect(stats.inputTokens).toBe(150);
		expect(stats.outputTokens).toBe(30);
		expect(stats.cacheRead).toBe(1850);
		expect(stats.totalTokens).toBe(2030);
	});

	it("上下文取**最近一条** assistant 的输入侧（不是累加）", () => {
		expect(summarizeSession(lines).contextTokens).toBe(1000); // 50 + 950
	});

	it("坏行 / 空行不会炸", () => {
		expect(summarizeSession(["", "not json", "{", ...lines]).totalMessages).toBe(4);
		expect(summarizeSession([])).toEqual(emptyStats());
	});
});
