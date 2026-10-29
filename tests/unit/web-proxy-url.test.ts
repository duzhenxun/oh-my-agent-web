/**
 * 网页代理的地址规则（ADR-0047）：`server/web-proxy/proxy-url.ts` 与
 * `web/src/url-bar.ts` 是**同一个规则的两处实现**（服务端要反解、客户端要正拼），
 * 这里把它们钉在一起 —— 只要有一边跑偏，前端拼出来的地址服务端就认不出来。
 *
 * 另外锁住改写规则的两个要害：
 *   - 根相对（`/img/a.png`）必须进代理前缀，否则会跑回我们自己的根上 404；
 *   - 绝对地址 / `data:` / `#锚点` 一律不动（动它们只会把页面改坏）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proxyPathOf, targetOfProxyPath } from "../../server/web-proxy/proxy-url.ts";
import { rewriteCss, rewriteHtml } from "../../server/web-proxy/rewrite.ts";
import { proxyUrlOf } from "../../web/src/url-bar.ts";

describe("web-proxy 地址规则", () => {
	it("客户端拼接与服务端反解一致", () => {
		const cases = [
			"https://www.baidu.com/",
			"https://www.baidu.com/s?wd=hello%20world&ie=utf-8",
			"http://127.0.0.1:3000/a/b.html?x=1#frag",
			"https://github.com/duzhenxun/oh-my-agent-web/pulls",
		];
		for (const target of cases) {
			const path = proxyUrlOf(target);
			assert.ok(path, `拼不出代理地址：${target}`);
			assert.equal(path, proxyPathOf(target));
			const at = path.indexOf("?");
			const pathname = at < 0 ? path : path.slice(0, at);
			const search = at < 0 ? "" : path.slice(at);
			const parsed = new URL(target);
			assert.equal(
				targetOfProxyPath(pathname, search),
				`${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`,
			);
		}
	});

	it("非法地址不拼、不认", () => {
		assert.equal(proxyUrlOf("javascript:alert(1)"), null);
		assert.equal(proxyUrlOf("随便写的"), null);
		assert.equal(targetOfProxyPath("/web/p/ftp/x/y"), null);
		assert.equal(targetOfProxyPath("/web/p/https"), null);
		assert.equal(targetOfProxyPath("/other/https/x/y"), null);
	});
});

describe("网页改写", () => {
	const scope = { scheme: "https", host: "www.baidu.com" };

	it("根相对进代理，绝对地址与锚点不动", () => {
		const html = `<a href="/s?wd=x">a</a><img src="/img/logo.png"><a href="#top">t</a><a href="https://x.com/a">x</a>`;
		const out = rewriteHtml(html, scope);
		assert.match(out, /href="\/web\/p\/https\/www\.baidu\.com\/s\?wd=x"/);
		assert.match(out, /src="\/web\/p\/https\/www\.baidu\.com\/img\/logo\.png"/);
		assert.match(out, /href="#top"/);
		assert.match(out, /href="https:\/\/x\.com\/a"/);
	});

	it("协议相对补协议直连（否则我们这边可能是 http）", () => {
		assert.match(rewriteHtml(`<script src="//cdn.x/a.js"></script>`, scope), /src="https:\/\/cdn\.x\/a\.js"/);
	});

	it("拦截脚本塞进 head，且不会被自己改写出递归前缀", () => {
		const out = rewriteHtml(`<html><head><title>t</title></head><body></body></html>`, scope);
		assert.ok(out.includes("location.href=next"));
		// 注入一次就够：二次改写不会把脚本里的 /web/p/ 再包一层
		assert.equal(rewriteHtml(out, scope).includes("/web/p/https/www.baidu.com/web/p/"), false);
	});

	it("CSS 的 url() 同样只改根相对", () => {
		const css = `a{background:url(/img/a.png)}b{background:url("https://x.com/b.png")}`;
		const out = rewriteCss(css, scope);
		assert.match(out, /url\(\/web\/p\/https\/www\.baidu\.com\/img\/a\.png\)/);
		assert.match(out, /url\("https:\/\/x\.com\/b\.png"\)/);
	});
});
