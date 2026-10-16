/**
 * 会话条目 → 界面消息的映射（ADR-0021 §2）。
 *
 * 事实源换成 pi 的会话存储之后，「显示」就落在这个纯函数上：
 * 输入 SDK 的 `SessionEntry[]`，输出我们的 `UiMessage[]`（text / tool / error 块）。
 *
 * 用合成条目覆盖全部形状，不需要拉起 SDK —— 这是这层能被快速回归的原因。
 */
import { describe, expect, it } from "vitest";
import type { MessageBlock } from "../../server/protocol.js";
import { entriesToUiMessages, firstUserText } from "../../server/engine/pi-transcript.js";

const entry = (id: string, message: unknown, timestamp = 1000) => ({
	type: "message",
	id,
	parentId: null,
	timestamp,
	message,
});

const userEntry = (id: string, text: string) =>
	entry(id, { role: "user", content: [{ type: "text", text }], timestamp: 1000 });

const assistantTextEntry = (id: string, text: string) =>
	entry(id, {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1100,
		api: "x",
		provider: "x",
		model: "x",
	});

const assistantToolEntry = (id: string, toolCallId: string, name: string, args: unknown) =>
	entry(id, {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
		timestamp: 1200,
		api: "x",
		provider: "x",
		model: "x",
	});

const toolResultEntry = (
	id: string,
	toolCallId: string,
	toolName: string,
	output: string,
	options: { isError?: boolean; exitCode?: number } = {},
) =>
	entry(id, {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: output }],
		details: options.exitCode === undefined ? {} : { exitCode: options.exitCode },
		isError: options.isError === true,
		timestamp: 1300,
	});

describe("entriesToUiMessages", () => {
	it("用户与助手文本各自成一条消息", () => {
		const messages = entriesToUiMessages([userEntry("e1", "帮我改个 bug"), assistantTextEntry("e2", "好的")]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[0].blocks).toEqual([{ kind: "text", text: "帮我改个 bug" }]);
		expect(messages[1].id).toBe("e2");
	});

	it("工具调用成块，工具结果按 toolCallId 回填（成功）", () => {
		const messages = entriesToUiMessages([
			userEntry("e1", "跑测试"),
			assistantToolEntry("e2", "t1", "bash", { command: "npm test" }),
			toolResultEntry("e3", "t1", "bash", "全部通过"),
		]);
		const tool = messages[1].blocks[0];
		expect(tool).toMatchObject({
			kind: "tool",
			name: "bash",
			status: "ok",
			outputExcerpt: "全部通过",
			truncated: false,
		});
	});

	it("工具失败带退出码", () => {
		const messages = entriesToUiMessages([
			assistantToolEntry("e1", "t1", "bash", { command: "npm test" }),
			toolResultEntry("e2", "t1", "bash", "1 failing", { isError: true, exitCode: 1 }),
		]);
		expect(messages[0].blocks[0]).toMatchObject({ status: "failed", exitCode: 1, outputExcerpt: "1 failing" });
	});

	it("超长工具输出被截断（与实时渲染同一个上限）", () => {
		const long = "x".repeat(5000);
		const messages = entriesToUiMessages([
			assistantToolEntry("e1", "t1", "bash", {}),
			toolResultEntry("e2", "t1", "bash", long),
		]);
		const tool = messages[0].blocks[0] as Extract<MessageBlock, { kind: "tool" }>;
		expect(tool.truncated).toBe(true);
		expect(tool.outputExcerpt).toHaveLength(2000);
	});

	it("没有对应工具块的裸结果不会丢（补一条块）", () => {
		const messages = entriesToUiMessages([toolResultEntry("e1", "t9", "bash", "孤立结果")]);
		expect(messages).toHaveLength(1);
		expect(messages[0].blocks[0]).toMatchObject({ kind: "tool", status: "ok", outputExcerpt: "孤立结果" });
	});

	it("思考块不进界面（v1 不展示）", () => {
		const entryWithThinking = entry("e1", {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "想了一下" },
				{ type: "text", text: "结论" },
			],
			timestamp: 1,
		});
		const blocks = entriesToUiMessages([entryWithThinking])[0].blocks;
		expect(blocks).toEqual([{ kind: "text", text: "结论" }]);
	});

	it("状态类条目（model_change 等）被忽略", () => {
		const messages = entriesToUiMessages([
			{ type: "model_change", id: "m1", provider: "p", modelId: "m" },
			{ type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
			userEntry("e1", "唯一的内容"),
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0].blocks).toEqual([{ kind: "text", text: "唯一的内容" }]);
	});

	it("空消息/空文本不产生空壳消息", () => {
		expect(entriesToUiMessages([entry("e1", { role: "user", content: [] }), userEntry("e2", "   ")])).toEqual([]);
	});

	it("system 消息不进界面", () => {
		expect(entriesToUiMessages([entry("e1", { role: "system", content: "你是…" })])).toEqual([]);
	});

	it("时间戳缺失也不崩（用当前时间兜底）", () => {
		const messages = entriesToUiMessages([{ type: "message", id: "e1", message: { role: "user", content: "x" } }]);
		expect(typeof messages[0].ts).toBe("number");
	});

	it("图片内容等非文本部件不影响解析", () => {
		const withImage = entry("e1", {
			role: "user",
			content: [
				{ type: "image", data: "x" },
				{ type: "text", text: "看图" },
			],
			timestamp: 1,
		});
		expect(entriesToUiMessages([withImage])[0].blocks).toEqual([{ kind: "text", text: "看图" }]);
	});

	it("多条助手消息里的多个工具按顺序保留", () => {
		const messages = entriesToUiMessages([
			assistantToolEntry("e1", "t1", "read", { path: "a.ts" }),
			toolResultEntry("e2", "t1", "read", "内容 A"),
			assistantToolEntry("e3", "t2", "read", { path: "b.ts" }),
			toolResultEntry("e4", "t2", "read", "内容 B"),
		]);
		expect(messages).toHaveLength(2);
		expect(messages[0].blocks[0]).toMatchObject({ name: "read", outputExcerpt: "内容 A" });
		expect(messages[1].blocks[0]).toMatchObject({ name: "read", outputExcerpt: "内容 B" });
	});
});

describe("firstUserText", () => {
	it("取首条用户消息（折叠空白）", () => {
		expect(
			firstUserText([entry("e0", { role: "system", content: "prompt" }), userEntry("e1", "  帮我看\n\n这个  ")]),
		).toBe("帮我看 这个");
	});

	it("没有用户消息时返回空串", () => {
		expect(firstUserText([assistantTextEntry("e1", "只有助手")])).toBe("");
	});
});
