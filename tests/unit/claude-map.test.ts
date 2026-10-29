/**
 * Claude Code（claude-code-acp）的 ACP 映射（`server/engine/claude-map.ts`）。
 *
 * 这些断言不是「照着实现再抄一遍」，每条都对应一个实测事实：
 *   - `session/new` 给的是 `models.availableModels`，**没有 configOptions**（与 opencode / dsh 不同）；
 *   - 正文是增量（`agent_message_chunk`），不拼起来就是一行一个字；
 *   - `tool_call` 第一条就带齐 `rawInput`（不需要像 opencode 那样延迟开卡片）；
 *   - 权限有**两组**选项（普通工具 / ExitPlanMode），写死 optionId 会回错包。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	currentModelId,
	currentModelOf,
	friendlyClaudeError,
	modelIdFor,
	modelOptions,
	parseClaudeModelId,
	permissionApprovalRequest,
	permissionOptionId,
	stopReasonToTurnEnd,
	summarizeToolInput,
	textEventOf,
	toolEndEvent,
	toolFactsOf,
	toolStartEvent,
	type ClaudeModels,
	type ToolFacts,
} from "../../server/engine/claude-map.ts";

/** 实测 `session/new` 的 models 段（Claude Code 2.1.301 + claude-code-acp 0.16.2） */
const models: ClaudeModels = {
	availableModels: [
		{ modelId: "default", name: "Default (recommended)" },
		{ modelId: "opus", name: "Opus" },
		{ modelId: "haiku", name: "Haiku" },
		{ modelId: "claude-opus-4-6", name: "claude-opus-4-6" },
	],
	currentModelId: "opus",
};

describe("模型表", () => {
	it("id 统一成 anthropic/<modelId>，当前那条带 current", () => {
		const options = modelOptions(models);
		assert.deepEqual(
			options.map((option) => option.id),
			["anthropic/default", "anthropic/opus", "anthropic/haiku", "anthropic/claude-opus-4-6"],
		);
		assert.equal(options.find((option) => option.current)?.id, "anthropic/opus");
	});

	it("别名与全名都原样保留（Claude 自己认这两个）", () => {
		assert.equal(parseClaudeModelId("anthropic/opus"), "opus");
		assert.equal(parseClaudeModelId("opus"), "opus");
		assert.equal(parseClaudeModelId("anthropic/"), null);
		assert.equal(parseClaudeModelId("   "), null);
	});

	it("切模型只认列表里有的（不在列表 → null，界面给出可读原因）", () => {
		assert.equal(modelIdFor(models, "anthropic/haiku"), "haiku");
		assert.equal(modelIdFor(models, "claude-opus-4-6"), "claude-opus-4-6");
		assert.equal(modelIdFor(models, "anthropic/gpt-9"), null);
		assert.equal(modelIdFor({}, "opus"), null);
	});

	it("currentModelId / currentModel 的空值都落到 null（还没建会话时）", () => {
		assert.equal(currentModelId(models), "opus");
		assert.equal(currentModelId({}), null);
		assert.deepEqual(currentModelOf(models), { provider: "anthropic", model: "opus" });
		assert.equal(currentModelOf({}), null);
	});
});

describe("session/update → 事件", () => {
	it("正文与思考都是增量，各自一类", () => {
		assert.deepEqual(textEventOf({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你" } }), {
			type: "text_delta",
			text: "你",
		});
		assert.deepEqual(textEventOf({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } }), {
			type: "thinking_delta",
			text: "想一下",
		});
	});

	it("plan / available_commands / 空增量都不产生事件（不能变成空气泡）", () => {
		assert.equal(textEventOf({ sessionUpdate: "plan", entries: [] }), null);
		assert.equal(textEventOf({ sessionUpdate: "available_commands_update" }), null);
		assert.equal(textEventOf({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }), null);
	});

	it("工具事实取 _meta 里的真工具名（title 只是人话，认不出是什么工具）", () => {
		const facts = toolFactsOf({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_1",
			title: "`npm test`",
			kind: "execute",
			rawInput: { command: "npm test" },
			_meta: { claudeCode: { toolName: "Bash" } },
		});
		assert.deepEqual(facts, {
			toolCallId: "toolu_1",
			toolName: "Bash",
			title: "`npm test`",
			kind: "execute",
			rawInput: { command: "npm test" },
		});
		assert.equal(toolFactsOf({ sessionUpdate: "tool_call" }), null);
	});

	it("工具参数摘要按工具挑一句人话（命令 / 路径），认不出才退回 JSON", () => {
		assert.equal(summarizeToolInput("Bash", { command: "npm test", description: "跑测试" }), "npm test");
		assert.equal(summarizeToolInput("Write", { file_path: "/repo/a.ts", content: "x" }), "/repo/a.ts");
		assert.equal(summarizeToolInput("Grep", { pattern: "TODO" }), "TODO");
		assert.equal(summarizeToolInput("WebFetch", { url: "https://example.com" }), "https://example.com");
		assert.equal(summarizeToolInput("Task", { description: "找入口" }), "找入口");
		assert.equal(summarizeToolInput("mcp__x__y", { foo: 1 }), '{"foo":1}');
	});

	it("开卡片：摘要与完整参数一样时不重复给 argsFull", () => {
		const facts: ToolFacts = { toolCallId: "t1", toolName: "Bash", rawInput: { command: "npm test" } };
		const event = toolStartEvent(facts);
		assert.deepEqual(event, {
			type: "tool_start",
			toolCallId: "t1",
			name: "Bash",
			argsSummary: "npm test",
		});
	});

	it("开卡片：参数比摘要丰富时留一份完整的（展开看全 + 复制）", () => {
		const facts: ToolFacts = {
			toolCallId: "t2",
			toolName: "Write",
			rawInput: { file_path: "/repo/a.ts", content: "x" },
		};
		const event = toolStartEvent(facts);
		assert.equal(event.type, "tool_start");
		assert.equal(event.type === "tool_start" ? event.argsSummary : "", "/repo/a.ts");
		assert.match(event.type === "tool_start" ? (event.argsFull ?? "") : "", /"content":"x"/);
	});

	it("收口：completed → ok，failed → failed；输出从 rawOutput 里取文本", () => {
		const ok = toolEndEvent({
			toolCallId: "t1",
			status: "completed",
			rawOutput: [{ type: "text", text: "all green" }],
		});
		assert.deepEqual(ok, { type: "tool_end", toolCallId: "t1", status: "ok", output: "all green" });
		const bad = toolEndEvent({ toolCallId: "t2", status: "failed", rawOutput: "boom" });
		assert.deepEqual(bad, { type: "tool_end", toolCallId: "t2", status: "failed", output: "boom" });
	});

	it("stopReason：cancelled 是「被打断」，refusal 是错，其余都算正常结束", () => {
		assert.equal(stopReasonToTurnEnd("cancelled"), "interrupted");
		assert.equal(stopReasonToTurnEnd("refusal"), "error");
		assert.equal(stopReasonToTurnEnd("end_turn"), "done");
		assert.equal(stopReasonToTurnEnd(undefined), "done");
	});
});

describe("权限请求 → 审批", () => {
	const facts: ToolFacts = {
		toolCallId: "toolu_1",
		toolName: "Bash",
		title: "`rm -rf build`",
		kind: "execute",
		rawInput: { command: "rm -rf build" },
	};

	it("工具名取缓存里的真名，摘要取命令原文，风险话术按 kind", () => {
		const request = permissionApprovalRequest(
			{
				sessionId: "s1",
				toolCall: { toolCallId: "toolu_1", title: "`rm -rf build`", rawInput: { command: "rm -rf build" } },
			},
			facts,
		);
		assert.equal(request.toolName, "Bash");
		assert.equal(request.argsSummary, "rm -rf build");
		assert.equal(request.scopeKey, "claude|Bash");
		assert.match(request.riskNote, /执行这条命令/);
	});

	it("缓存里没有工具事实也能出审批（用标题兜底，不能空着）", () => {
		const request = permissionApprovalRequest({
			toolCall: { toolCallId: "toolu_9", title: "Write /repo/a.ts", rawInput: { file_path: "/repo/a.ts" } },
		});
		assert.equal(request.toolName, "Write /repo/a.ts");
		assert.equal(request.argsSummary, "/repo/a.ts");
	});

	it("普通工具那组：三态按 kind 匹配", () => {
		const options = [
			{ optionId: "allow_always", kind: "allow_always" },
			{ optionId: "allow", kind: "allow_once" },
			{ optionId: "reject", kind: "reject_once" },
		];
		assert.equal(permissionOptionId(options, "always"), "allow_always");
		assert.equal(permissionOptionId(options, "once"), "allow");
		assert.equal(permissionOptionId(options, "deny"), "reject");
	});

	it("ExitPlanMode 那组：不认 optionId，只认 kind", () => {
		const options = [
			{ optionId: "acceptEdits", kind: "allow_always" },
			{ optionId: "default", kind: "allow_once" },
			{ optionId: "plan", kind: "reject_once" },
		];
		assert.equal(permissionOptionId(options, "always"), "acceptEdits");
		assert.equal(permissionOptionId(options, "once"), "default");
		assert.equal(permissionOptionId(options, "deny"), "plan");
	});

	it("一个选项都没给时也给一个能回包的答案（不能让对端干等）", () => {
		assert.equal(permissionOptionId(undefined, "once"), "allow");
		assert.equal(permissionOptionId([], "deny"), "reject");
	});
});

describe("错误 → 人话", () => {
	it("没装适配器 → 说清装哪个包", () => {
		assert.match(friendlyClaudeError(new Error("spawn claude-code-acp ENOENT")), /@zed-industries\/claude-code-acp/);
	});

	it("没登录 / 凭据失效 → 让人先去终端登录一次", () => {
		assert.match(friendlyClaudeError(new Error("authRequired")), /claude/);
		assert.match(friendlyClaudeError(new Error("API Error: 401 Invalid API key")), /登录/);
	});

	it("认不出的错误原样返回（别把真错误吞成一句套话）", () => {
		assert.equal(friendlyClaudeError(new Error("something odd")), "something odd");
	});
});
