/**
 * 转录落盘（ADR-0005）：追加写 + 半行容错 + 标题事件 + 元数据推导。
 * 用真实临时目录（不碰用户数据目录）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendText, createMessage } from "../../server/snapshot/messages.js";
import {
	appendMessage,
	appendTitle,
	conversationFile,
	createTranscript,
	deriveTitle,
	listTranscriptIds,
	metaFromTranscript,
	parseTranscript,
	readTranscript,
} from "../../server/session/jsonl-store.js";

let dataDir = "";

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "agent-web-jsonl-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

const meta = { v: 1, id: "conv-1", workspace: "/tmp/ws", createdAt: 1000, title: "第一个会话" };

describe("追加写与读取", () => {
	it("写 meta + 消息 + 改名事件，读回来结构完整", async () => {
		await createTranscript(dataDir, meta);
		const user = appendText(createMessage("m1", "user", 1001), "你好");
		const assistant = appendText(createMessage("m2", "assistant", 1002), "你好，我在。");
		await appendMessage(dataDir, "conv-1", user);
		await appendMessage(dataDir, "conv-1", assistant);
		await appendTitle(dataDir, "conv-1", "改过的标题", 1003);

		const transcript = await readTranscript(dataDir, "conv-1");
		expect(transcript.exists).toBe(true);
		expect(transcript.meta).toEqual(meta);
		expect(transcript.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
		expect(transcript.title).toBe("改过的标题");
		expect(transcript.skipped).toBe(0);
	});

	it("文件不存在时给出 exists:false 而不是抛错", async () => {
		const transcript = await readTranscript(dataDir, "不存在");
		expect(transcript.exists).toBe(false);
		expect(transcript.messages).toEqual([]);
	});

	it("列出所有会话 id（按名字排序，忽略非 jsonl）", async () => {
		await createTranscript(dataDir, { ...meta, id: "b" });
		await createTranscript(dataDir, { ...meta, id: "a" });
		writeFileSync(join(dataDir, "conversations", "notes.txt"), "x");
		expect(await listTranscriptIds(dataDir)).toEqual(["a", "b"]);
	});
});

describe("容错：坏行只跳过自己（ADR-0005 守卫 1）", () => {
	it("末尾半行（崩溃残留）被跳过，并标记 skippedTail", async () => {
		await createTranscript(dataDir, meta);
		await appendMessage(dataDir, "conv-1", appendText(createMessage("m1", "user", 1001), "第一句"));
		// 模拟:进程在中途被杀,留下半行 JSON
		writeFileSync(conversationFile(dataDir, "conv-1"), '{"kind":"message","id":"m2","role":"assist', { flag: "a" });

		const transcript = await readTranscript(dataDir, "conv-1");
		expect(transcript.messages.map((message) => message.id)).toEqual(["m1"]);
		expect(transcript.skipped).toBe(1);
		expect(transcript.skippedTail).toBe(true);
	});

	it("中间坏行被跳过，后面的消息照常读出来", async () => {
		await createTranscript(dataDir, meta);
		writeFileSync(
			conversationFile(dataDir, "conv-1"),
			[
				'{"kind":"message","id":"m1","role":"user","ts":1,"blocks":[]}',
				"{ 这不是 JSON",
				'{"kind":"unknown","whatever":true}',
				'{"kind":"message","id":"m2","role":"assistant","ts":2,"blocks":[]}',
			].join("\n") + "\n",
			{ flag: "a" },
		);

		const transcript = await readTranscript(dataDir, "conv-1");
		expect(transcript.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
		expect(transcript.skipped).toBe(2);
		expect(transcript.skippedTail).toBe(false);
	});

	it("容忍「一行一条消息」不带 kind 的写法（ADR-0005 的字面口径）", () => {
		const parsed = parseTranscript('{"id":"m1","role":"user","ts":1,"blocks":[]}\n');
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.skipped).toBe(0);
	});

	it("缺字段的消息行算坏行（不会被塞进 UI）", () => {
		const parsed = parseTranscript('{"kind":"message","id":"m1","role":"user","blocks":[]}\n');
		expect(parsed.messages).toHaveLength(0);
		expect(parsed.skipped).toBe(1);
	});

	it("空文件不报错", () => {
		expect(parseTranscript("")).toEqual({ meta: null, messages: [], title: null, skipped: 0, skippedTail: false });
	});
});

describe("元数据推导（索引重建用，纯函数）", () => {
	it("标题取 meta；消息数与时间取转录", () => {
		const parsed = parseTranscript(
			[
				'{"v":1,"kind":"meta","id":"conv-1","workspace":"/tmp/ws","createdAt":1000,"title":"标题"}',
				'{"kind":"message","id":"m1","role":"user","ts":1001,"blocks":[{"kind":"text","text":"hi"}]}',
				'{"kind":"message","id":"m2","role":"assistant","ts":1005,"blocks":[]}',
			].join("\n"),
		);
		expect(metaFromTranscript("conv-1", parsed)).toEqual({
			id: "conv-1",
			title: "标题",
			createdAt: 1000,
			updatedAt: 1005,
			workspace: "/tmp/ws",
			messageCount: 2,
		});
	});

	it("改名事件优先于 meta 标题", () => {
		const parsed = parseTranscript(
			[
				'{"v":1,"kind":"meta","id":"c","workspace":"/w","createdAt":1,"title":"旧"}',
				'{"kind":"title","title":"新","ts":9}',
			].join("\n"),
		);
		expect(metaFromTranscript("c", parsed).title).toBe("新");
	});

	it("没有标题时用首条用户消息兜底", () => {
		const parsed = parseTranscript(
			[
				'{"v":1,"kind":"meta","id":"c","workspace":"/w","createdAt":1,"title":""}',
				'{"kind":"message","id":"m1","role":"user","ts":2,"blocks":[{"kind":"text","text":"帮我改个 bug"}]}',
			].join("\n"),
		);
		expect(metaFromTranscript("c", parsed).title).toBe("帮我改个 bug");
	});
});

describe("标题规则（ADR-0005）", () => {
	it("取第一行并截断", () => {
		expect(deriveTitle("第一行\n第二行", 10)).toBe("第一行");
		expect(deriveTitle("这是一个很长很长的标题超过十个字了", 10)).toBe("这是一个很长很长的标…");
		expect(deriveTitle("   ")).toBe("新对话");
	});
});

describe("文件是纯追加的（可被外部工具消费）", () => {
	it("每行都是独立 JSON（人肉可读、可 grep）", async () => {
		await createTranscript(dataDir, meta);
		await appendMessage(dataDir, "conv-1", appendText(createMessage("m1", "user", 1001), "hi"));
		const lines = readFileSync(conversationFile(dataDir, "conv-1"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
		expect(JSON.parse(lines[0]).kind).toBe("meta");
		expect(JSON.parse(lines[1]).kind).toBe("message");
	});
});

describe("防御：id 撞车不许污染已有转录（ADR-0019）", () => {
	it("createTranscript 遇到已存在的 id 直接报错（不追加 meta）", async () => {
		await createTranscript(dataDir, meta);
		await expect(createTranscript(dataDir, meta)).rejects.toThrow(/已存在/);
		const lines = readFileSync(conversationFile(dataDir, "conv-1"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1); // 只有一个 meta 行
	});

	it("appendMessage 目标会话不存在时报错（不静默新建孤儿文件）", async () => {
		await expect(appendMessage(dataDir, "不存在", appendText(createMessage("m1", "user", 1), "hi"))).rejects.toThrow(
			/不存在/,
		);
		expect(existsSync(conversationFile(dataDir, "不存在"))).toBe(false);
	});

	it("appendTitle 目标会话不存在时报错", async () => {
		await expect(appendTitle(dataDir, "不存在", "t", 1)).rejects.toThrow(/不存在/);
	});
});
