/**
 * 「这一轮挂了要不要自己再试一次」的判断题。
 *
 * 背景：用户报的是「有时会 engine.provider_error / This operation was aborted」——
 * 传输层抖一下就把整轮打死，而 pi 自己的重试**不认这类错误**（abort 一律算终态）。
 * 这里只测判断本身：错误文本怎么归类、要抹掉会话树上的哪几条。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RETRY_MAX_ATTEMPTS,
	classifyProviderError,
	retryDelayMs,
	retryOmitTargets,
	type BranchEntryLike,
} from "../../server/engine/pi-retry.ts";

const message = (role: string, extra: Record<string, unknown> = {}) => ({ role, ...extra });

describe("provider 错误分类", () => {
	it("传输层 abort 算「可以再试」——这是用户报的那一条", () => {
		assert.equal(classifyProviderError("This operation was aborted"), "transient");
		assert.equal(classifyProviderError("Request was aborted"), "transient");
	});

	it("常见的连接抖动也算", () => {
		for (const text of [
			"socket hang up",
			"fetch failed",
			"other side closed",
			"read ECONNRESET",
			"stream ended without finish_reason",
			"upstream connect error or disconnect/reset before headers",
			"503 Service Unavailable",
			"429 Too Many Requests",
		]) {
			assert.equal(classifyProviderError(text), "transient", text);
		}
	});

	it("凭据 / 配额 / 上下文 / 参数不重试（换个时间也一样，只会多烧一遍钱）", () => {
		for (const text of [
			"Incorrect API key provided",
			"401 Unauthorized",
			"insufficient_quota",
			"Your credit balance is too low",
			"This model's maximum context length is 200000 tokens",
			"404 model not found",
			"invalid_request_error: messages: role must be user or assistant",
		]) {
			assert.equal(classifyProviderError(text), "fatal", text);
		}
	});

	it("认不出来的当 fatal：自动重试只给「明显是抖动」的", () => {
		assert.equal(classifyProviderError("boom"), "fatal");
		assert.equal(classifyProviderError(""), "fatal");
	});

	it("退避是短的：1s / 3s，再往后不再加长", () => {
		assert.equal(retryDelayMs(1), 1_000);
		assert.equal(retryDelayMs(2), 3_000);
		assert.equal(retryDelayMs(9), 3_000);
		assert.ok(RETRY_MAX_ATTEMPTS >= 1);
	});
});

describe("重试前抹掉哪几条", () => {
	const entry = (id: string, role: string, extra: Record<string, unknown> = {}): BranchEntryLike => ({
		type: "message",
		id,
		message: message(role, extra),
	});

	it("抹掉末尾那条失败的助手消息（用户那句要留着，重试从它接着跑）", () => {
		const ids = retryOmitTargets([entry("u1", "user"), entry("a1", "assistant", { stopReason: "error" })]);
		assert.deepEqual(ids, ["a1"]);
	});

	it("它调过的工具的 toolResult 要一起抹（配对不上会让下一次请求 400）", () => {
		const ids = retryOmitTargets([
			entry("u1", "user"),
			entry("a1", "assistant", {
				stopReason: "error",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
			}),
			entry("r1", "toolResult", { toolCallId: "t1" }),
		]);
		assert.deepEqual(ids, ["a1", "r1"]);
	});

	it("形状对不上（后面挂着别人家的 toolResult）就什么都不抹", () => {
		const ids = retryOmitTargets([
			entry("u1", "user"),
			entry("a1", "assistant", {
				stopReason: "error",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
			}),
			entry("r2", "toolResult", { toolCallId: "t-other" }),
		]);
		assert.deepEqual(ids, []);
	});

	it("末尾那些不贡献消息的 entry（usage / label / model_change）先跳过", () => {
		const ids = retryOmitTargets([
			entry("u1", "user"),
			entry("a1", "assistant", { stopReason: "error" }),
			{ type: "usage", id: "x1" },
			{ type: "label", id: "x2" },
		]);
		assert.deepEqual(ids, ["a1"]);
	});

	it("末尾不是助手消息就什么都不抹（宁可报错，也不要抹错东西）", () => {
		assert.deepEqual(retryOmitTargets([entry("u1", "user")]), []);
		assert.deepEqual(retryOmitTargets([]), []);
	});
});
