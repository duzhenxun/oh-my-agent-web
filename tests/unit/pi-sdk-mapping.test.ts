/**
 * 真实引擎的事件映射（ADR-0003 的端口实现里最容易出错的一层）。
 *
 * 这里**不连模型**：用「SDK 事件形状」的合成对象直接覆盖映射表，所以毫秒级、零 token。
 * 真实链路的手工验证在冒烟之外单独做（见 ROADMAP M3 的实际结果）。
 */
import { describe, expect, it } from "vitest";
import { mapSessionEvent, resultExitCode, resultText, summarizeArgs } from "../../server/engine/pi-events.js";
import { historyEntries } from "../../server/engine/pi-sdk.js";

describe("mapSessionEvent：正文增量", () => {
	it("text_delta 映射成 EngineEvent.text_delta", () => {
		const event = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } };
		expect(mapSessionEvent(event)).toEqual({ type: "text_delta", text: "你好" });
	});

	it("thinking_delta 不展示（v1 不渲染思考过程）", () => {
		expect(
			mapSessionEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想…" } }),
		).toBeNull();
	});

	it("空的 text_delta 不产生事件（避免无意义的增量帧）", () => {
		expect(
			mapSessionEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } }),
		).toBeNull();
	});

	it("没有 assistantMessageEvent 的 message_update 被忽略", () => {
		expect(mapSessionEvent({ type: "message_update", message: { role: "assistant" } })).toBeNull();
	});
});

describe("mapSessionEvent：工具调用", () => {
	it("tool_execution_start → tool_start（带参数摘要）", () => {
		const event = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } };
		expect(mapSessionEvent(event)).toEqual({
			type: "tool_start",
			toolCallId: "t1",
			name: "bash",
			argsSummary: '{"command":"npm test"}',
		});
	});

	it("tool_execution_end 成功 → status ok + 文本输出", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		};
		expect(mapSessionEvent(event)).toEqual({ type: "tool_end", toolCallId: "t1", status: "ok", output: "ok" });
	});

	it("tool_execution_end 失败 → status failed + 退出码", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: "1 failing" }], details: { exitCode: 1 } },
		};
		expect(mapSessionEvent(event)).toEqual({
			type: "tool_end",
			toolCallId: "t2",
			status: "failed",
			output: "1 failing",
			exitCode: 1,
		});
	});

	it("多段文本输出用换行拼接", () => {
		expect(
			resultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
	});

	it("没有内容 / 形状不对时给出空串而不是崩", () => {
		expect(resultText(undefined)).toBe("");
		expect(resultText({})).toBe("");
		expect(resultText({ content: "字符串" })).toBe("");
	});
});

describe("mapSessionEvent：其他事件", () => {
	it("生命周期事件不影响 UI（返回 null）", () => {
		for (const event of [
			{ type: "agent_start" },
			{ type: "agent_end", messages: [] },
			{ type: "agent_settled", aborted: false },
			{ type: "turn_start" },
			{ type: "turn_end", message: {}, toolResults: [] },
			{ type: "message_start", message: {} },
			{ type: "message_end", message: {} },
			{ type: "tool_execution_update", toolCallId: "t" },
			{ type: "queue_update", steering: [], followUp: [] },
			{ type: "unknown_future_event" },
		]) {
			expect(mapSessionEvent(event)).toBeNull();
		}
	});

	it("完全不是对象也不崩", () => {
		expect(mapSessionEvent(undefined)).toBeNull();
		expect(mapSessionEvent("字符串")).toBeNull();
		expect(mapSessionEvent(null)).toBeNull();
	});
});

describe("resultExitCode", () => {
	it("优先取 details.exitCode", () => {
		expect(resultExitCode({ details: { exitCode: 2 } })).toBe(2);
	});

	it("退回 structuredContent.exitCode", () => {
		expect(resultExitCode({ structuredContent: { exitCode: 127 } })).toBe(127);
	});

	it("没有退出码就不给（不能让界面显示 undefined）", () => {
		expect(resultExitCode({ details: {} })).toBeUndefined();
		expect(resultExitCode({ details: { exitCode: "1" } })).toBeUndefined();
		expect(resultExitCode(undefined)).toBeUndefined();
	});
});

describe("summarizeArgs", () => {
	it("对象序列化成 JSON", () => {
		expect(summarizeArgs({ path: "a.ts" })).toBe('{"path":"a.ts"}');
	});

	it("字符串原样返回", () => {
		expect(summarizeArgs("npm test")).toBe("npm test");
	});

	it("超长参数被截断到 200 字", () => {
		expect(summarizeArgs({ text: "x".repeat(500) }).length).toBe(201);
	});
});

describe("historyEntries（ADR-0018 的历史注入）", () => {
	it("user/assistant 依次成链，parentId 串起来", () => {
		const entries = historyEntries([
			{ role: "user", text: "问一句", ts: 1000 },
			{ role: "assistant", text: "答一句", ts: 2000 },
		]);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "message", id: "seed-0", parentId: null });
		expect(entries[1]).toMatchObject({ type: "message", id: "seed-1", parentId: "seed-0" });
	});

	it("消息形状符合 SDK 要求（user 有 content，assistant 补齐元数据占位）", () => {
		const [user, assistant] = historyEntries([
			{ role: "user", text: "hi", ts: 1 },
			{ role: "assistant", text: "hello", ts: 2 },
		]) as Array<{ message: Record<string, unknown> }>;
		expect(user.message).toMatchObject({ role: "user", content: [{ type: "text", text: "hi" }] });
		expect(assistant.message).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			api: "replay",
			provider: "replay",
		});
		expect(assistant.message.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("空白消息被跳过（不制造空条目）", () => {
		expect(historyEntries([{ role: "user", text: "  ", ts: 1 }])).toEqual([]);
	});

	it("空历史给出空数组（新会话不该有任何种子）", () => {
		expect(historyEntries([])).toEqual([]);
	});
});
