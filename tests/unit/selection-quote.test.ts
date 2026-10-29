/**
 * 「选中一段文字之后」的两个纯函数（`web/src/selection-quote.ts`）。
 *
 * 钉住两条容易写错的地方：多行要**逐行**加 `>`（只加开头一次的话，第二行起模型看不出是引用），
 * 以及接进已有草稿时**前后各空一行**（粘在上一句屁股上会被当成那句话的延续）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendQuote, quoteOf } from "../../web/src/selection-quote.ts";

describe("quoteOf", () => {
	it("单行 → 一行引用", () => {
		assert.equal(quoteOf("这块是什么呀"), "> 这块是什么呀");
	});

	it("多行 → 每行都带 >（中间的空行写成单个 >）", () => {
		assert.equal(quoteOf("第一行\n\n第三行"), "> 第一行\n>\n> 第三行");
	});

	it("CRLF 也按行切开，不会在行尾留 \\r", () => {
		assert.equal(quoteOf("a\r\nb"), "> a\n> b");
	});
});

describe("appendQuote", () => {
	it("空草稿：只有这一段引用，后面留一行空行给用户接着写", () => {
		assert.equal(appendQuote("", "> a"), "> a\n\n");
	});

	it("已有草稿：接在后面，前后各空一行（不冲掉用户已经打的字）", () => {
		assert.equal(appendQuote("先写一句", "> a"), "先写一句\n\n> a\n\n");
	});

	it("连续标两次 = 两段引用都在（多次标记 = 多段内容）", () => {
		const once = appendQuote("", quoteOf("第一段"));
		const twice = appendQuote(once, quoteOf("第二段"));
		assert.equal(twice, "> 第一段\n\n> 第二段\n\n");
	});
});
