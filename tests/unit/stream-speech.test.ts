/**
 * 流式朗读切句器：边出字边把「能念的句子」切出来。
 *
 * 用户的要求是「有文案输出就念」，而逐字念既难听又浪费请求 ——
 * 所以按句末标点切，太短的攒一句，代码块整段跳过（含跨帧未闭合的）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStreamReader } from "../../web/src/stream-speech.ts";

describe("流式朗读切句", () => {
	it("一段话分几次长出来：只在句末吐出完整句子，剩下的攒着", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("你好，这是"), []);
		assert.deepEqual(reader.push("你好，这是第一句。第二"), ["你好，这是第一句。"]);
		assert.deepEqual(reader.push("你好，这是第一句。第二句还没完"), []);
		assert.deepEqual(reader.push("你好，这是第一句。第二句还没完。"), ["第二句还没完。"]);
		assert.equal(reader.spoken, 2);
	});

	it("太短的句子和下一句一起念，不一顿一顿地跳", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("好。"), []);
		assert.deepEqual(reader.push("好。那我们现在开始。"), ["好。那我们现在开始。"]);
	});

	it("flush 把最后没标点的半句也念出来（收尾不丢话）", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("第一句。最后的半句没有句号"), ["第一句。"]);
		assert.deepEqual(reader.flush(), ["最后的半句没有句号"]);
		assert.deepEqual(reader.flush(), []);
	});

	it("代码块整段不念，包括跨两帧才闭合的代码块", () => {
		const reader = createStreamReader();
		// 代码块前面的那句话照念；代码本身整段跳过
		assert.deepEqual(reader.push("先看这个：\n```js\nconsole.log(1)\n"), ["先看这个："]);
		assert.deepEqual(reader.push("先看这个：\n```js\nconsole.log(1)\n```\n然后继续。"), ["然后继续。"]);
		assert.deepEqual(reader.flush(), []);
	});

	it("行内代码、加粗、链接都剥成能念的文字", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("用 `npm run dev` 启动，见 [文档](https://example.com)。"), [
			"用 npm run dev 启动，见 文档。",
		]);
	});

	it("超长的一句话（模型不写句号）按逗号先切一段出来", () => {
		const reader = createStreamReader();
		const long = `${"这是一个很长的从句，".repeat(12)}结束。`;
		const units = reader.push(long);
		const rest = reader.flush();
		assert.ok(units.length >= 2, `应当先切出至少两段，实际：${JSON.stringify(units)}`);
		assert.ok(
			[...units, ...rest].every((unit) => unit.length <= 100),
			"每段都要短到能马上开口",
		);
		// 一个字都不能丢：切出来的段拼回去就是原文（标点保留）
		assert.equal([...units, ...rest].join(""), long);
	});

	it("校正帧比上一帧短时不重念已经念过的内容", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("第一句。第二句。"), ["第一句。", "第二句。"]);
		assert.deepEqual(reader.push("第一句。"), []);
		assert.deepEqual(reader.push("第一句。第二句。第三句。"), ["第三句。"]);
	});

	it("只有标点的片段不念", () => {
		const reader = createStreamReader();
		assert.deepEqual(reader.push("。。。\n\n"), []);
		assert.deepEqual(reader.flush(), []);
	});

	it("reset 之后从新一轮的开头重新念", () => {
		const reader = createStreamReader();
		reader.push("旧的一轮。");
		reader.reset();
		assert.equal(reader.spoken, 0);
		assert.deepEqual(reader.push("新的一轮。"), ["新的一轮。"]);
	});
});
