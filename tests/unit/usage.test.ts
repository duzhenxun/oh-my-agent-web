/**
 * token 用量：各家 provider 字段名不一样，解析必须都认；
 * 顺手守一下「单条消息的 usage 会进 UiMessage」（尾注显示用）。
 */
import { describe, expect, it } from "vitest";
import { parseUsage } from "../../server/util/usage.js";
import { entriesToUiMessages } from "../../server/engine/pi-transcript.js";

describe("parseUsage", () => {
	it("驼峰字段", () => {
		expect(parseUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })).toEqual({
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
		});
	});

	it("下划线 / OpenAI 风格也认", () => {
		expect(parseUsage({ input_tokens: 5, output_tokens: 6, cache_read: 7, cache_write: 8 })).toEqual({
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
		});
		expect(parseUsage({ promptTokens: 1, completionTokens: 2, cachedTokens: 3 })?.cacheRead).toBe(3);
	});

	it("全 0 / 不是对象 → null（界面就不显示这一行）", () => {
		expect(parseUsage({})).toBeNull();
		expect(parseUsage(null)).toBeNull();
		expect(parseUsage({ input: 0, output: 0 })).toBeNull();
	});
});

describe("历史回放带用量", () => {
	it("assistant 消息把 usage 带上（尾注要显示）", () => {
		const messages = entriesToUiMessages([
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					timestamp: 1,
					content: [{ type: "text", text: "好了" }],
					usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 },
				},
			},
		] as never);
		expect(messages[0]?.usage).toEqual({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0 });
	});
});
