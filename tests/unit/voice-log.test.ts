/**
 * 语音诊断日志的客户端一侧（`web/src/voice-log.ts`）。
 *
 * 锁三件事，因为这三件错了会让排查反而更糟：
 *   1. 文本摘要只留长度 + 前缀（别把用户说的话整段写进日志）；
 *   2. 载荷形状对（`{ event, detail? }`），服务端端点按这个形状解析；
 *   3. 窗口内限流（识别 partial 每 300ms 一条，不能无限发）。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { textSummary, voiceLog } from "../../web/src/voice-log.ts";

type Captured = { url: string; body: string };

let captured: Captured[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
	captured = [];
	globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
		captured.push({ url: String(url), body: String(init?.body) });
		return { ok: true } as Response;
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("textSummary", () => {
	it("只给长度和前 24 个字", () => {
		const summary = textSummary("一二三四五六七八九十".repeat(5));
		assert.equal(summary.textLen, 50);
		assert.equal(summary.textHead.length, 24);
	});

	it("空文本也能安全摘要", () => {
		assert.deepEqual(textSummary(""), { textLen: 0, textHead: "" });
	});
});

describe("voiceLog", () => {
	it("把事件和上下文按 { event, detail } 发出去", async () => {
		voiceLog("status", { from: "idle", to: "listening" });
		await Promise.resolve();
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.url, "/api/client-log");
		assert.deepEqual(JSON.parse(captured[0]!.body), {
			event: "status",
			detail: { from: "idle", to: "listening" },
		});
	});

	it("没有上下文时只发事件名", async () => {
		voiceLog("stop");
		await Promise.resolve();
		assert.deepEqual(JSON.parse(captured[0]!.body), { event: "stop" });
	});

	it("fetch 抛错不会冒出来（诊断日志不能拖垮页面）", async () => {
		globalThis.fetch = (() => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		assert.doesNotThrow(() => voiceLog("start"));
	});

	it("窗口内超过上限就丢", async () => {
		for (let index = 0; index < 200; index += 1) voiceLog("spam");
		await Promise.resolve();
		assert.ok(captured.length > 0);
		assert.ok(captured.length <= 120, `限流没生效，实际发了 ${captured.length} 条`);
	});
});
