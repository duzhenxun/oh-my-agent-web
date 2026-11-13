/**
 * 「网址不是文件路径」（`web/src/url-tokens.ts` + `web/src/path-tokens.ts`）。
 *
 * 用户 2026-11-10：「这种 http/https 的连接要在新标签中打开，这属于网址」。
 * 事故形状：模型把三套环境的地址写成行内代码或贴成一个代码块，`index.html` 的后缀正好在
 * 路径白名单里 → `looksLikePath` 认成工作区文件 → 渲染成点状下划线的路径按钮 →
 * 点了去右侧面板找一个**不存在**的文件。所以这里钉两件事：
 *   1. 网址被认出来（`isUrl` / `urlTokens`），句尾标点不算地址；
 *   2. 路径那条线（`looksLikePath` / `pathTokens`）不再把网址当路径，但仍认得真路径。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUrl, trimUrlToken, urlTokens } from "../../web/src/url-tokens.ts";
import { looksLikePath, looksLikePathListing, pathTokens } from "../../web/src/path-tokens.ts";

const LINE = "https://boc.inke.cn/react/banner/202611/shadow-archive/index.html";

describe("isUrl", () => {
	it("协议 + 主机就算网址（后缀是 .html 也一样）", () => {
		assert.equal(isUrl(LINE), true);
		assert.equal(isUrl("http://127.0.0.1:25257/x"), true);
		assert.equal(isUrl("  https://betaboc.inke.cn/a  "), true);
		// 查询串、锚点都算进网址里
		assert.equal(isUrl("https://example.com/a?b=1#c"), true);
	});

	it("光秃秃的协议 / 非 http(s) / 带空白的不算", () => {
		assert.equal(isUrl("https://"), false);
		assert.equal(isUrl("https:///a.html"), false);
		assert.equal(isUrl("ftp://a/b"), false);
		assert.equal(isUrl("file:///tmp/a.html"), false);
		assert.equal(isUrl("https://a.com/x y"), false);
		assert.equal(isUrl("docs/report.html"), false);
		assert.equal(isUrl(""), false);
	});
});

describe("trimUrlToken", () => {
	it("剥掉句尾标点（中英文都算）", () => {
		assert.equal(trimUrlToken("https://a.cn/x.html,"), "https://a.cn/x.html");
		assert.equal(trimUrlToken("https://a.cn/x.html。"), "https://a.cn/x.html");
		// 只在**末尾**剥：中间/末尾的括号算地址的一部分（wiki 链接就带括号）
		assert.equal(trimUrlToken("https://a.cn/x_(y)"), "https://a.cn/x_(y)");
	});

	it("不是网址返回 null", () => {
		assert.equal(trimUrlToken("https://"), null);
		assert.equal(trimUrlToken("hello"), null);
	});
});

describe("urlTokens", () => {
	it("切成「文字 / 网址」，句尾标点留在文字里", () => {
		assert.deepEqual(urlTokens(`看 ${LINE}。`), [{ text: "看 " }, { text: LINE, url: LINE }, { text: "。" }]);
	});

	it("没有网址时原样一段文字（调用方据此不额外包节点）", () => {
		assert.deepEqual(urlTokens("你好，世界"), [{ text: "你好，世界" }]);
		// 只有协议没有主机：当文字，不拼出不存在的链接
		assert.deepEqual(urlTokens("https:// 是协议头"), [{ text: "https:// 是协议头" }]);
	});

	it("一行里多个网址", () => {
		const urls = urlTokens("boc https://boc.inke.cn/a 与 https://betaboc.inke.cn/b")
			.filter((part) => part.url !== undefined)
			.map((part) => part.url);
		assert.deepEqual(urls, ["https://boc.inke.cn/a", "https://betaboc.inke.cn/b"]);
	});
});

describe("路径识别不再吃网址", () => {
	it("looksLikePath（行内代码）否掉网址", () => {
		assert.equal(looksLikePath(LINE), false);
		// 真路径照旧
		assert.equal(looksLikePath("docs/report.html"), true);
		assert.equal(looksLikePath("1111.json"), true);
	});

	it("pathTokens 把网址标成 url，不当 path", () => {
		const parts = pathTokens(`请打开 ${LINE}`);
		const url = parts.find((part) => part.url !== undefined);
		assert.equal(url?.text, LINE);
		assert.equal(
			parts.some((part) => part.path !== undefined),
			false,
		);
	});

	it("网址后面的标点不被吞掉", () => {
		const parts = pathTokens(`${LINE}。`);
		assert.equal(parts.at(-1)?.text, "。");
	});

	it("同一行里网址与真路径各归各", () => {
		const parts = pathTokens(`https://boc.inke.cn/a/index.html 与 docs/report.html`);
		assert.deepEqual(
			parts.filter((part) => part.url !== undefined).map((part) => part.url),
			["https://boc.inke.cn/a/index.html"],
		);
		assert.deepEqual(
			parts.filter((part) => part.path !== undefined).map((part) => part.path),
			["docs/report.html"],
		);
	});
});

describe("looksLikePathListing", () => {
	it("一组环境地址算清单（逐行可点，新标签页打开）", () => {
		const block = [
			"ali-bj：https://boc.inke.cn/react/banner/202611/shadow-archive/index.html",
			"ali-gray：https://betaboc.inke.cn/react/banner/202611/shadow-archive/index.html",
			"ali-testqa：https://testqaboc.inke.cn/react/banner/202611/shadow-archive/index.html",
		].join("\n");
		assert.equal(looksLikePathListing(block), true);
	});

	it("普通源码块不算清单", () => {
		// 普通源码块（没有一半以上的行带路径/网址）
		assert.equal(looksLikePathListing("let count = 0;\ncount += 1;\nreturn count;"), false);
		// 只有一行：不算清单，照常上色
		assert.equal(looksLikePathListing("https://boc.inke.cn/a/index.html"), false);
	});
});
