/**
 * Edge TTS 的失败预算：单次 8s + 一次重试。
 *
 * 为什么值得单测：重试策略写错的两个方向都很贵 —— 该重试的不重试（用户看到「朗读坏了」），
 * 不该重试的硬重试（被上游限流时越打越久）。这里只测纯逻辑，不碰网络。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ATTEMPT_TIMEOUT_MS,
	MAX_ATTEMPTS,
	shouldRetryEdgeFailure,
	TTS_TIMEOUT_MS,
	withEdgeRetry,
} from "../../server/tts/edge.js";
import { TtsError } from "../../server/tts/types.js";

const signal = () => new AbortController().signal;
const transient = () => new TtsError(504, "Edge TTS 合成超时");

describe("withEdgeRetry", () => {
	it("瞬时失败重试一次，第二次成功就正常返回", async () => {
		let calls = 0;
		const audio = await withEdgeRetry(async () => {
			calls += 1;
			if (calls === 1) throw transient();
			return Buffer.from("mp3");
		}, signal());
		assert.deepEqual(audio, Buffer.from("mp3"));
		assert.equal(calls, 2);
	});

	it("最多只试 MAX_ATTEMPTS 次，最后一次的错误原样抛出", async () => {
		let calls = 0;
		await assert.rejects(
			withEdgeRetry(async () => {
				calls += 1;
				throw transient();
			}, signal()),
			/timed out|合成超时/i,
		);
		assert.equal(calls, MAX_ATTEMPTS);
	});

	it("限流不重试：立刻再打只会拿到同样的回应", async () => {
		let calls = 0;
		await assert.rejects(
			withEdgeRetry(async () => {
				calls += 1;
				throw new TtsError(429, "Edge TTS 上游限流，请稍后再试");
			}, signal()),
			/限流/,
		);
		assert.equal(calls, 1);
	});

	it("请求已取消就不再打上游", async () => {
		const controller = new AbortController();
		let calls = 0;
		await assert.rejects(
			withEdgeRetry(async () => {
				calls += 1;
				controller.abort(new TtsError(499, "TTS 请求已取消"));
				throw controller.signal.reason;
			}, controller.signal),
		);
		assert.equal(calls, 1);
	});
});

describe("edge 超时预算", () => {
	it("单次 8 秒，不再是 45 秒", () => {
		assert.equal(ATTEMPT_TIMEOUT_MS, 8_000);
	});

	it("总预算容得下所有尝试，service 的兜底定时器不会先把重试掐掉", () => {
		assert.ok(
			TTS_TIMEOUT_MS > MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS,
			`TTS_TIMEOUT_MS(${TTS_TIMEOUT_MS}) 必须大于 ${MAX_ATTEMPTS} × ${ATTEMPT_TIMEOUT_MS}`,
		);
	});
});

describe("shouldRetryEdgeFailure", () => {
	it("握手超时 / 没有音频这类瞬时失败重试", () => {
		assert.equal(shouldRetryEdgeFailure(new TtsError(504, "Edge TTS 合成超时"), 1), true);
		assert.equal(shouldRetryEdgeFailure(new TtsError(502, "Edge TTS 未返回有效音频"), 1), true);
		assert.equal(shouldRetryEdgeFailure(new TtsError(502, "Edge TTS 连接提前结束"), 1), true);
	});

	it("次数用完之后一律不重试", () => {
		assert.equal(shouldRetryEdgeFailure(new TtsError(504, "Edge TTS 合成超时"), MAX_ATTEMPTS), false);
	});

	it("429 / 403 是限流，不重试（不管包成什么错误）", () => {
		assert.equal(shouldRetryEdgeFailure(new TtsError(429, "Edge TTS 上游限流，请稍后再试"), 1), false);
		assert.equal(shouldRetryEdgeFailure(new Error("Unexpected server response: 429"), 1), false);
		assert.equal(shouldRetryEdgeFailure(new Error("Unexpected server response: 403"), 1), false);
	});
});
