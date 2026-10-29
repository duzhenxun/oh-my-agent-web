/**
 * 语音合成失败码 → 人话（`web/src/tts.ts` 的 `describeSpeechError`）。
 *
 * 为什么值得单测：浏览器合成失败是**静默**的（不报错、就是没声音），面板上那行红字是唯一线索。
 * 这张表里最常见的几个码都必须是「能照做的一句话」，不能回落到 `语音合成失败：xxx`。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeSpeechError } from "../../web/src/tts.ts";

describe("describeSpeechError", () => {
	it("常见失败码都翻成了能照做的中文", () => {
		// 「没声」最常见的两个：浏览器拦截 / 音色不可用
		assert.match(describeSpeechError("not-allowed"), /点一下/);
		assert.match(describeSpeechError("voice-unavailable"), /音色/);
		assert.match(describeSpeechError("network"), /联网/);
		assert.match(describeSpeechError("audio-hardware"), /音频输出/);
		assert.match(describeSpeechError("synthesis-unavailable"), /语音服务/);
		// 一个码都不该漏成默认分支
		for (const code of [
			"not-allowed",
			"voice-unavailable",
			"audio-busy",
			"audio-hardware",
			"network",
			"synthesis-unavailable",
			"synthesis-failed",
			"text-too-long",
			"invalid-argument",
		]) {
			assert.doesNotMatch(describeSpeechError(code), /^语音合成失败：/, `${code} 要有专门的文案`);
		}
	});

	it("没见过的码原样带上，不吞", () => {
		assert.match(describeSpeechError("weird-code"), /weird-code/);
	});
});
