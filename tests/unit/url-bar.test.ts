/**
 * 地址栏解析（`web/src/url-bar.ts`）：右侧「网页」页的输入归一化。
 *
 * 这里锁三件事：
 *   1. 没写协议就补 `https://`（`github.com`、`localhost:3000` 都要能用）；
 *   2. `javascript:` / `data:` / `file:` 这类不能进 iframe 的协议直接拒绝（返回 null）；
 *   3. 标签上的短名字去掉 `www.`。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostOf, normalizeUrl } from "../../web/src/url-bar.ts";

describe("url-bar", () => {
	it("没写协议时补协议：本机用 http，其余 https", () => {
		assert.equal(normalizeUrl("github.com"), "https://github.com/");
		assert.equal(normalizeUrl("  example.com/a/b?c=1 "), "https://example.com/a/b?c=1");
		// 本机服务基本都是 http：`localhost:3000` 走 https 只会得到「连不上」
		assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
		assert.equal(normalizeUrl("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
	});

	it("写了 http(s) 就照原样", () => {
		assert.equal(normalizeUrl("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
		assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
	});

	it("空串与不能嵌的协议返回 null", () => {
		assert.equal(normalizeUrl(""), null);
		assert.equal(normalizeUrl("   "), null);
		// 这些进 iframe 不是没意义就是危险
		assert.equal(normalizeUrl("javascript:alert(1)"), null);
		assert.equal(normalizeUrl("data:text/html,<h1>x</h1>"), null);
		assert.equal(normalizeUrl("file:///etc/passwd"), null);
	});

	it("标签上的短名字", () => {
		assert.equal(hostOf("https://www.google.com/search?q=1"), "google.com");
		assert.equal(hostOf("https://boc.inke.cn/x"), "boc.inke.cn");
		// 不是网址就给回原文，别在标签上显示空白
		assert.equal(hostOf("随便写的"), "随便写的");
	});
});
