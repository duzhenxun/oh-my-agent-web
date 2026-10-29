/**
 * Claude Code 的会话文件解析（`server/engine/claude-sessions.ts`）。
 *
 * 关键事实（实测 Claude Code 2.1.301 的 JSONL）：
 *   - **一次模型调用一条 `assistant` 条目**：带工具的一轮会写好几条，界面必须合成一条，
 *     否则一次回复被切成「先说一句 / 工具 / 再说一句」三截；
 *   - `tool_result` 在**下一条 user 条目**里，只能回填到之前那张工具卡片上；
 *   - 用量只在 `message.usage` 里（`session/prompt` 不返回 usage），花费只在 `cost-state` 里；
 *   - 目录名编码不可逆，cwd 只能取条目字段。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createClaudeSessionsProvider,
	encodeProjectPath,
	groupClaudeSessions,
	lastTurnUsage,
	parseTranscript,
	sessionMetaOf,
	sessionModelOf,
	transcriptStats,
	transcriptToTranscript,
	transcriptToUiMessages,
	type ClaudeEntry,
} from "../../server/engine/claude-sessions.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 6, 0, seconds)).toISOString();

/** 一个真实形状的回合：用户提问 → 读文件 → 工具结果 → 收尾 */
const turn: ClaudeEntry[] = [
	{
		type: "user",
		uuid: "u1",
		sessionId: "s1",
		cwd: "/repo/app",
		timestamp: at(0),
		message: { role: "user", content: "帮我看看构建脚本" },
	},
	// 内部记账条目：不是对话，必须跳过
	{ type: "queue-operation", timestamp: at(0), sessionId: "s1" },
	{
		type: "assistant",
		uuid: "a1",
		sessionId: "s1",
		cwd: "/repo/app",
		timestamp: at(1),
		message: {
			role: "assistant",
			model: "claude-opus-4-6",
			content: [
				{ type: "thinking", thinking: "先读构建脚本" },
				{ type: "text", text: "我先看 build.sh" },
				{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/app/build.sh" } },
			],
			usage: {
				input_tokens: 100,
				output_tokens: 20,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 10,
			},
		},
	},
	{
		type: "user",
		uuid: "u2",
		sessionId: "s1",
		cwd: "/repo/app",
		timestamp: at(2),
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "echo hi" }],
		},
	},
	{
		type: "assistant",
		uuid: "a2",
		sessionId: "s1",
		cwd: "/repo/app",
		timestamp: at(3),
		message: {
			role: "assistant",
			model: "claude-opus-4-6",
			content: [{ type: "text", text: "构建脚本没问题" }],
			usage: { input_tokens: 200, output_tokens: 30 },
		},
	},
	{ type: "cost-state", sessionId: "s1", totalCostUSD: 0.12 },
];

describe("parseTranscript", () => {
	it("坏行跳过，好行照读（历史版本 / 截断的半行不该让整条会话消失）", () => {
		const entries = parseTranscript('{"type":"user"}\n不是 JSON\n\n{"type":"assistant"}');
		assert.deepEqual(
			entries.map((entry) => entry.type),
			["user", "assistant"],
		);
	});
});

describe("transcriptToUiMessages", () => {
	it("一个回合合成一条 assistant 消息，工具结果回填到卡片上", () => {
		const messages = transcriptToUiMessages(turn);
		assert.equal(messages.length, 2);

		const [user, assistant] = messages;
		assert.equal(user?.role, "user");
		assert.deepEqual(user?.blocks, [{ kind: "text", text: "帮我看看构建脚本" }]);

		assert.equal(assistant?.role, "assistant");
		assert.deepEqual(
			assistant?.blocks.map((block) => block.kind),
			["thinking", "text", "tool", "text"],
		);
		const tool = assistant?.blocks[2];
		assert.equal(tool?.kind === "tool" ? tool.name : "", "Read");
		assert.equal(tool?.kind === "tool" ? tool.argsSummary : "", "/repo/app/build.sh");
		assert.equal(tool?.kind === "tool" ? tool.status : "", "ok");
		assert.equal(tool?.kind === "tool" ? tool.outputExcerpt : "", "echo hi");
	});

	it("用量求和、模型与完成时间都带上（界面尾注要这些）", () => {
		const assistant = transcriptToUiMessages(turn)[1];
		assert.deepEqual(assistant?.usage, { input: 300, output: 50, cacheRead: 50, cacheWrite: 10 });
		assert.equal(assistant?.model, "anthropic/claude-opus-4-6");
		assert.equal(assistant?.endedAt, Date.parse(at(3)));
	});

	it("注入的上下文（<system-reminder>）不算用户说的话", () => {
		const messages = transcriptToUiMessages([
			{
				type: "user",
				uuid: "u1",
				timestamp: at(0),
				message: { role: "user", content: "<system-reminder>环境信息</system-reminder>" },
			},
			{ type: "user", uuid: "u2", timestamp: at(1), message: { role: "user", content: "真问题" } },
		]);
		assert.deepEqual(
			messages.map((message) => (message.blocks[0]?.kind === "text" ? message.blocks[0].text : "")),
			["真问题"],
		);
	});

	it("子代理的侧链（isSidechain）不进主对话", () => {
		const messages = transcriptToUiMessages([
			{
				type: "user",
				uuid: "u1",
				isSidechain: true,
				timestamp: at(0),
				message: { role: "user", content: "子代理的任务" },
			},
			{
				type: "assistant",
				uuid: "a1",
				isSidechain: true,
				timestamp: at(1),
				message: { role: "assistant", content: [{ type: "text", text: "子代理的答复" }] },
			},
		]);
		assert.deepEqual(messages, []);
	});

	it("api_error 映射成 error 块（界面上要看得到这句话）", () => {
		const messages = transcriptToUiMessages([
			{
				type: "system",
				subtype: "api_error",
				uuid: "e1",
				timestamp: at(0),
				error: { message: "401 Invalid API key" },
			},
		]);
		assert.deepEqual(messages[0]?.blocks, [
			{ kind: "error", code: "claude.api_error", message: "401 Invalid API key" },
		]);
	});
});

describe("transcriptToTranscript", () => {
	it("只留正文（用户提问 + 助手说的话），不带工具", () => {
		assert.deepEqual(
			transcriptToTranscript(turn).map((message) => [message.role, message.text]),
			[
				["user", "帮我看看构建脚本"],
				["assistant", "我先看 build.sh"],
				["assistant", "构建脚本没问题"],
			],
		);
	});
});

describe("统计 / 用量", () => {
	it("消息数、工具数、四桶用量、上下文占用、花费", () => {
		const stats = transcriptStats(turn);
		assert.equal(stats.userMessages, 1);
		assert.equal(stats.assistantMessages, 2);
		assert.equal(stats.totalMessages, 3);
		assert.equal(stats.toolCalls, 1);
		assert.equal(stats.toolResults, 1);
		assert.equal(stats.inputTokens, 300);
		assert.equal(stats.outputTokens, 50);
		assert.equal(stats.cacheRead, 50);
		assert.equal(stats.cacheWrite, 10);
		assert.equal(stats.totalTokens, 410);
		// 最后一条 assistant 的输入侧
		assert.equal(stats.contextTokens, 200);
		assert.equal(stats.cost, 0.12);
	});

	it("没有 cost-state 就不给 cost（不编 0）", () => {
		assert.equal(transcriptStats(turn.slice(0, -1)).cost, undefined);
	});

	it("这一轮的用量只算最后一条真人输入之后的 assistant", () => {
		assert.deepEqual(lastTurnUsage(turn), { input: 300, output: 50, cacheRead: 50, cacheWrite: 10 });
		// 只看后半段：手动截一条「用户只问了一句、还没回复」
		assert.equal(
			lastTurnUsage([{ type: "user", message: { role: "user", content: "又问一句" }, timestamp: at(9) }]),
			null,
		);
	});

	it("会话模型取最后一条 assistant 的 model（<synthetic> 是错误占位，不算）", () => {
		assert.deepEqual(sessionModelOf(turn), { provider: "anthropic", model: "claude-opus-4-6" });
		assert.equal(
			sessionModelOf([
				{
					type: "assistant",
					message: { role: "assistant", model: "<synthetic>", content: [] },
				},
			]),
			null,
		);
	});
});

describe("侧栏清单", () => {
	it("encodeProjectPath 与适配器一致（非字母数字一律变 -）", () => {
		assert.equal(encodeProjectPath("/repo/app"), "-repo-app");
		assert.equal(encodeProjectPath("/a/b-c"), "-a-b-c");
	});

	it("元数据：cwd / 标题 / 起止时间 / 模型", () => {
		const meta = sessionMetaOf("s1", "/tmp/s1.jsonl", turn, Date.parse(at(5)));
		assert.equal(meta?.cwd, "/repo/app");
		assert.equal(meta?.title, "帮我看看构建脚本");
		assert.equal(meta?.model, "claude-opus-4-6");
		assert.equal(meta?.startedAt, Date.parse(at(0)));
		assert.equal(meta?.updatedAt, Date.parse(at(5)));
	});

	it("临时目录里跑出来的会话不进侧栏", () => {
		const scratch: ClaudeEntry[] = turn.map((entry) => ({ ...entry, cwd: "/tmp/scratch" }));
		assert.equal(sessionMetaOf("s2", "/tmp/s2.jsonl", scratch, 0), null);
		assert.equal(sessionMetaOf("s3", "/tmp/s3.jsonl", [], 0), null);
	});

	it("按 cwd 分组，组内与会话组之间都按时间倒序", () => {
		const projects = groupClaudeSessions([
			{ id: "old", file: "/p/old.jsonl", cwd: "/repo/app", title: "旧", startedAt: 1, updatedAt: 10, model: null },
			{ id: "new", file: "/p/new.jsonl", cwd: "/repo/app", title: "新", startedAt: 2, updatedAt: 30, model: null },
			{
				id: "other",
				file: "/p/other.jsonl",
				cwd: "/repo/web",
				title: "别的",
				startedAt: 3,
				updatedAt: 20,
				model: null,
			},
		]);
		assert.deepEqual(
			projects.map((project) => [project.name, project.sessions.map((session) => session.id)]),
			[
				["app", ["new", "old"]],
				["web", ["other"]],
			],
		);
		// 打开历史会话要用这两个句柄：ACP 认 id，读文件认路径
		assert.equal(projects[0]?.sessions[0]?.engineSessionId, "new");
		assert.equal(projects[0]?.sessions[0]?.sessionPath, "/p/new.jsonl");
	});

	it("清单提供者读 dir/projects/<encoded>/<id>.jsonl，跳过 agent-*.jsonl", async () => {
		const home = mkdtempSync(join(tmpdir(), "claude-home-"));
		const dir = join(home, "projects", encodeProjectPath("/repo/app"));
		mkdirSync(dir, { recursive: true });
		const write = (name: string, entries: ClaudeEntry[]) =>
			writeFileSync(join(dir, name), entries.map((entry) => JSON.stringify(entry)).join("\n"));
		write("s1.jsonl", turn);
		write("agent-internal.jsonl", turn);

		const list = createClaudeSessionsProvider({ home });
		const projects = await list();
		assert.equal(projects.length, 1);
		assert.deepEqual(
			projects[0]?.sessions.map((session) => session.id),
			["s1"],
		);
	});
});
