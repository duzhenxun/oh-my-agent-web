/**
 * opencode export 的**两代结构**都要能解析（ADR-0054 之后修的 bug）。
 *
 * 背景（2026-11-24 用户报「使用 ocagent 时点会话的标题中间出不来会话内容」）：
 * opencode v2.3.2 把 `export` 的输出**拍平了一层**：
 *
 *   老版（pocess 代码一直按它写的）：
 *     { info: { role, id, time, tokens }, parts: [{ type, text | state }] }
 *   新版：
 *     user      → { id, time, type: "user", text }
 *     assistant → { id, time, type: "assistant", content: [...], tokens }
 *     system    → { id, time, type: "system", text }
 *
 * 解析器只认 `info.role` / `parts`，于是新版会话被读成 **0 条消息** —— 界面上就是
 * 「点开会话，中间一片空白」。这一组用例把两代结构都钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpencodeExport } from "../../server/engine/opencode-map.ts";
import {
	exportStats,
	exportToTranscript,
	exportToUiMessages,
	hasPendingUsage,
	normalizeExport,
} from "../../server/engine/opencode-map.ts";

/** 新版（v2.3.2）的真实形状：字段名取自实测导出 */
const V2: OpencodeExport = {
	info: { id: "ses_demo", title: "demo" },
	messages: [
		{ id: "m1", type: "user", time: { created: 1 }, text: "帮我看看群机器人" },
		{
			id: "m2",
			type: "assistant",
			time: { created: 2, completed: 9 },
			tokens: { input: 10, output: 5, cache: { read: 3, write: 0 } },
			content: [
				{ type: "reasoning", text: "先查 skill" },
				{ type: "text", text: "命令如下" },
				{
					type: "tool",
					id: "call_1",
					name: "bash",
					state: { status: "completed", input: { cmd: "ls" }, content: [{ type: "text", text: "a.txt" }] },
				},
			],
		},
		// 系统消息（工具名变了那种通知）：不是对话内容，不能画到界面上
		{ id: "m3", type: "system", time: { created: 10 }, text: "The available tools have changed." },
	],
};

/** 老版形状（代码原本支持的）：拿它做回归，别把老用户修坏了 */
const V1: OpencodeExport = {
	messages: [
		{ info: { id: "o1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "老版提问" }] },
		{
			info: { id: "o2", role: "assistant", time: { created: 2 }, tokens: { input: 7, output: 4 } },
			parts: [
				{ type: "text", text: "老版回答" },
				{
					type: "tool",
					callID: "c1",
					tool: "read",
					state: { status: "completed", input: { path: "a.md" }, output: "内容" },
				},
			],
		},
	],
};

test("新版结构：user / assistant 都能解析出消息，system 被跳过", () => {
	const ui = exportToUiMessages(V2);
	assert.equal(ui.length, 2, "应该是 1 条用户 + 1 条助手（system 不算）");
	assert.equal(ui[0]?.role, "user");
	const firstBlock = ui[0]?.blocks[0];
	assert.equal(firstBlock?.kind, "text");
	if (firstBlock?.kind === "text") assert.equal(firstBlock.text, "帮我看看群机器人");
	assert.equal(ui[1]?.role, "assistant");
	// 助手块顺序：思考 → 正文 → 工具
	assert.deepEqual(
		ui[1]?.blocks.map((block) => block.kind),
		["thinking", "text", "tool"],
	);
});

test("新版结构：工具块的 name / 状态 / 输出（state.content 数组）都要搬对", () => {
	const ui = exportToUiMessages(V2);
	const tool = ui[1]?.blocks.find((block) => block.kind === "tool");
	assert.ok(tool && tool.kind === "tool");
	if (!tool || tool.kind !== "tool") return;
	assert.equal(tool.name, "bash", "新版用 name，老版用 tool —— 两个字段名都要认");
	assert.equal(tool.status, "ok");
	assert.match(tool.outputExcerpt, /a\.txt/, "输出在 state.content 数组里，要能提取出来");
});

test("新版结构：统计能拿到消息数与 token（以前这里全是 0）", () => {
	const stats = exportStats(V2);
	assert.equal(stats.userMessages, 1);
	assert.equal(stats.assistantMessages, 1);
	assert.equal(stats.toolCalls, 1);
	assert.equal(stats.inputTokens, 10);
	assert.equal(stats.outputTokens, 5);
	assert.equal(stats.cacheRead, 3);
});

test("新版结构：转录同样能出来（导出 / 导出对话两个出口别只修一个）", () => {
	const transcript = exportToTranscript(V2);
	assert.equal(transcript.length, 2);
	assert.equal(transcript[0]?.text, "帮我看看群机器人");
	assert.equal(transcript[1]?.text, "命令如下");
});

test("老版结构不受影响（回归）", () => {
	const ui = exportToUiMessages(V1);
	assert.equal(ui.length, 2);
	const tool = ui[1]?.blocks.find((block) => block.kind === "tool");
	assert.ok(tool && tool.kind === "tool");
	if (!tool || tool.kind !== "tool") return;
	assert.equal(tool.name, "read");
	assert.match(tool.outputExcerpt, /内容/);
	const stats = exportStats(V1);
	assert.equal(stats.inputTokens, 7);
	assert.equal(stats.outputTokens, 4);
});

test("normalizeExport 幂等：连着归一化两次结果一致", () => {
	const once = normalizeExport(V2);
	const twice = normalizeExport(once);
	assert.deepEqual(twice, once);
});

test("还在跑的助手消息判为 pending（统计要等一下重读）", () => {
	assert.equal(hasPendingUsage(V2), false);
	const pending: OpencodeExport = {
		messages: [{ id: "p1", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "半截" }] }],
	};
	assert.equal(hasPendingUsage(pending), true, "没有 tokens 的 assistant = 还没记账");
});
