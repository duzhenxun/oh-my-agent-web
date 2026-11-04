/**
 * 同源外壳（`server/web-proxy/wrapper.ts`）：有的页面（带 WebView 桥、启动就读 cookie 的）
 * 在不透明源的沙箱里根本跑不起来，整页黑屏。外壳让页面与**它自己那一层**同源、与工作台不同源。
 *
 * 这里钉住三件不能破的事：
 *   1. 内核是**代理地址**（`/web/p/…`），不是原网址直连 —— 直连就又回到 X-Frame-Options 那里；
 *   2. 中继脚本要**在 iframe 之前**挂上监听（页面可能缓存命中、立刻发 ready，晚一步就丢了）；
 *   3. `u` 里的内容只能出现在属性值里，且必须转义（不然一个引号就能从属性里跑出来）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WRAPPER_PATH, wrapperHtml } from "../../server/web-proxy/wrapper.ts";
import { proxyPathOf } from "../../server/web-proxy/proxy-url.ts";

describe("同源外壳", () => {
	it("路径在 /web/ 下，与代理同一族", () => {
		assert.equal(WRAPPER_PATH, "/web/w");
	});

	it("嵌的是代理地址；中继脚本在 iframe 前面", () => {
		const target = "https://boc.inke.cn/react/x/index.html?uid=1&sid=2";
		const proxied = proxyPathOf(target);
		assert.ok(proxied);
		const html = wrapperHtml(proxied, target);
		// 属性里的 & 必须转义成 &amp;：不转的话 HTML 解析器会把后面的 y=2 当成新属性
		assert.ok(html.includes(`src="${proxied.replace(/&/g, "&amp;")}"`), html.slice(0, 400));
		const listenAt = html.indexOf("addEventListener");
		const frameAt = html.indexOf("<iframe");
		assert.ok(listenAt >= 0 && frameAt > listenAt, "中继监听必须早于 iframe");
	});

	it("两个方向都中继，且只认 __aw 标记", () => {
		const html = wrapperHtml("/web/p/https/example.com/", "https://example.com/");
		assert.ok(html.includes('MARK = "picker"'));
		assert.ok(html.includes('data.__aw !== MARK'));
		assert.ok(html.includes("event.source === window.parent"), "工作台 → 页面");
		assert.ok(html.includes("event.source === inner()"), "页面 → 工作台");
	});

	it("标题里的尖括号不会变成标签", () => {
		const html = wrapperHtml("/web/p/https/example.com/", `"><script>alert(1)</script>`);
		assert.ok(!html.includes("<script>alert(1)</script>"));
	});
});
