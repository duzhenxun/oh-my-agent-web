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
import { hostOf, normalizeUrl, siblingLoopbackHost, wrapperUrlOf } from "../../web/src/url-bar.ts";

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

	/**
	 * 同源外壳的地址规则（ADR-0047 补充）：页面要有一个「真实的源」才跑得起来，
	 * 但那个源不能是工作台自己的 —— 所以换到兄弟回环主机上。
	 */
	it("兄弟回环主机：127.0.0.1 ↔ localhost，别的一律没有", () => {
		assert.equal(siblingLoopbackHost("127.0.0.1"), "localhost");
		assert.equal(siblingLoopbackHost("LOCALHOST"), "127.0.0.1");
		assert.equal(siblingLoopbackHost("::1"), "127.0.0.1");
		// 局域网 IP / 域名：没有兄弟回环主机可用，调用方回落到原来的沙箱
		assert.equal(siblingLoopbackHost("192.168.1.9"), null);
		assert.equal(siblingLoopbackHost("agent.example.com"), null);
	});

	it("外壳地址：换主机、留端口、原网址整体编码进 u", () => {
		const url = wrapperUrlOf("https://boc.inke.cn/a/b?x=1&y=2", {
			protocol: "http:",
			hostname: "127.0.0.1",
			port: "25257",
		});
		assert.equal(url, `http://localhost:25257/web/w?u=${encodeURIComponent("https://boc.inke.cn/a/b?x=1&y=2")}`);
		// 反向也成立（用户在 localhost 上打开工作台时，页面跑在 127.0.0.1 上）
		assert.equal(
			wrapperUrlOf("https://example.com/", { protocol: "http:", hostname: "localhost", port: "8080" }),
			`http://127.0.0.1:8080/web/w?u=${encodeURIComponent("https://example.com/")}`,
		);
	});

	it("外壳地址：远程 / https / 非网页时不给（回落到原沙箱）", () => {
		const remote = { protocol: "http:", hostname: "192.168.1.9", port: "25257" };
		assert.equal(wrapperUrlOf("https://example.com/", remote), null);
		// https 下换主机名会撞证书，宁可不启用外壳
		assert.equal(wrapperUrlOf("https://example.com/", { protocol: "https:", hostname: "127.0.0.1", port: "25257" }), null);
		// 代理不了的地址也就没有外壳
		assert.equal(wrapperUrlOf("file:///etc/passwd", { protocol: "http:", hostname: "127.0.0.1", port: "25257" }), null);
	});
});
