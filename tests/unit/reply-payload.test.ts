/**
 * 回包载荷放在哪一格（`server/ws/reply-frame.ts` + 三个会带载荷的 handler）。
 *
 * 用户 2026-11-24：「分叉功能有 bug」。查下来根因就在这一格：
 * `reply()` 只转发 `{ ok: true, result }` 里的 **`result`**，而 `new_chat` / `fork_session` /
 * `suggest_title` 曾经把结果扁平地传进来（`{ ok: true, conversationId }`）——
 * 载荷被当成"没有"丢掉，客户端读 `message.result.conversationId` 永远是 undefined，
 * 于是「新建 / 分叉出来的会话顶到侧栏第一位」（`pinNewSessionOnTop`）从来没生效过。
 *
 * 这里钉两件事：
 *   1. 帧的形状：载荷在 `result` 里；扁平字段**不**被兜底（兜底了就把约定藏起来了）；
 *   2. handler 真的把载荷包进 `result` 了 —— 拿桩 runtime 跑 `handleMessage`，
 *      看 `reply` 收到的第三参（以及最终帧）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMessage, type ClientSink } from "../../server/ws/handle-message.ts";
import { replyFrame } from "../../server/ws/reply-frame.ts";

describe("replyFrame：载荷只走 result 这一格", () => {
	it("没有载荷 → 帧里不出现 result", () => {
		assert.deepEqual(replyFrame("r1", { ok: true }), { type: "reply", id: "r1", ok: true });
	});

	it("带载荷 → 原样放进 result", () => {
		assert.deepEqual(replyFrame("r2", { ok: true, result: { conversationId: "abc" } }), {
			type: "reply",
			id: "r2",
			ok: true,
			result: { conversationId: "abc" },
		});
	});

	it("失败 → 只带 error（不带 result）", () => {
		assert.deepEqual(replyFrame("r3", { ok: false, error: { code: "x.y", message: "炸了" } }), {
			type: "reply",
			id: "r3",
			ok: false,
			error: { code: "x.y", message: "炸了" },
		});
	});
});

/** 喂一条请求给 handleMessage，收集它吐出来的帧 */
async function runRequest(request: Record<string, unknown>, runtime: Record<string, unknown>): Promise<unknown[]> {
	const frames: unknown[] = [];
	const socket: ClientSink = { send: (payload: string) => frames.push(JSON.parse(payload)) };
	await handleMessage(socket, JSON.stringify(request), {
		runtime: runtime as never,
		clientId: "test-client",
		reply: (sink, id, result) => sink.send(JSON.stringify(replyFrame(id, result))),
		sender: { pushSnapshot: () => undefined, flush: () => undefined } as never,
		logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never,
		runProviderRequest: async () => undefined,
	});
	return frames;
}

describe("handler 把载荷包进 result（分叉 / 新建 / AI 起名）", () => {
	it("fork_session：回包能读到新分支的 conversationId", async () => {
		const frames = await runRequest(
			{ id: "req-fork", type: "fork_session", payload: { conversationId: "old", messageId: "m1" } },
			{
				forkSession: async () => ({ ok: true, conversationId: "branch-1", workspace: "/tmp/w" }),
			},
		);
		assert.deepEqual(frames, [
			{
				type: "reply",
				id: "req-fork",
				ok: true,
				result: { ok: true, conversationId: "branch-1", workspace: "/tmp/w" },
			},
		]);
	});

	it("fork_session 失败：回包是 ok:false + error（界面据此弹错）", async () => {
		const frames = await runRequest(
			{ id: "req-fork2", type: "fork_session", payload: { conversationId: "old" } },
			{ forkSession: async () => ({ ok: false, error: { code: "session.empty", message: "没有可分叉的点" } }) },
		);
		assert.deepEqual(frames, [
			{ type: "reply", id: "req-fork2", ok: false, error: { code: "session.empty", message: "没有可分叉的点" } },
		]);
	});

	it("new_chat：回包能读到新会话的 conversationId（排到侧栏第一位要用它）", async () => {
		const frames = await runRequest(
			{ id: "req-new", type: "new_chat", payload: {} },
			{ newConversation: async () => ({ ok: true, conversationId: "conv-9" }) },
		);
		assert.deepEqual(frames, [
			{ type: "reply", id: "req-new", ok: true, result: { ok: true, conversationId: "conv-9" } },
		]);
	});

	it("suggest_title：客户端按 result.ok 判成败，所以载荷里必须有 ok", async () => {
		const frames = await runRequest(
			{ id: "req-title", type: "suggest_title", payload: { conversationId: "c1" } },
			{ suggestSessionTitle: async () => ({ ok: true, title: "分叉测试" }) },
		);
		assert.deepEqual(frames, [
			{ type: "reply", id: "req-title", ok: true, result: { ok: true, title: "分叉测试" } },
		]);
	});
});
