/**
 * ADR-0047：`/web/p/…` 网页代理 —— 让「拒绝被嵌入」的站点也能在右侧面板里打开。
 *
 * 浏览器拒绝嵌入只看**文档**的响应头（`X-Frame-Options` / `CSP frame-ancestors`）。
 * 我们把这个文档从服务端取回来、把那些头丢掉、用自己的源发出去，页面就能嵌了。
 *
 * 三条边界，写清楚免得以后被当成万能浏览器：
 *   1. **只代理文档与 CSS**（HTML / CSS 要改写根相对地址）；图片、字体、脚本等子资源
 *      在镜像路径下由浏览器直连原站，不经过这里 —— 省带宽、也少一层故障点；
 *   2. **不带 cookie 过去、也不把 Set-Cookie 带回来**：这里不做登录态隧道，
 *      要看登录后的页面请用地址栏右边的 ⧉ 跳系统浏览器；
 *   3. **不隐藏来源**：请求带的是浏览器 UA，日志里记一行目标地址 —— 这是本机自用工具，
 *      不是给人做匿名代理的。服务端只监听 loopback 且整站有鉴权（ADR-0031）。
 */
import express, { type Express, type Request, type Response } from "express";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { MOBILE_PREFIX, proxyPathOf, PROXY_PREFIX, targetOfProxyPath } from "./proxy-url.js";
import { rewriteCss, rewriteHtml } from "./rewrite.js";
import { WRAPPER_PATH, wrapperHtml } from "./wrapper.js";

/** 上游响应最多收多大：一屏网页足够，太大说明是下载链接，那种应该走 ⧉ 跳出去 */
const MAX_BYTES = 12 * 1024 * 1024;

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 手机模式的 UA（走 `/web/m/` 前缀时用它）。
 *
 * 为什么光收窄 iframe 不够：很多站点（百度是典型）按 **User-Agent** 决定发电脑版还是手机版，
 * 跟视口宽度没关系 —— 只把 iframe 收到 390px，它们照样回电脑版 HTML/CSS，
 * 「手机尺寸预览」看上去就是电脑排版。UA 一换，服务端才会给那一版。
 * 用 iPhone 的 UA（而不是泛泛的 "Mobile"）：不少站点对 iOS/Android 走不同的分发逻辑，
 * 报一个具体机型比报一个模糊的手机 UA 更接近真机。
 */
const MOBILE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export function registerWebProxyRoutes(app: Express, deps: { log: (text: string) => void }): void {
	/**
	 * 同源外壳（见 `wrapper.ts`）：`/web/w?u=<原网址>`。
	 *
	 * 它自己的 HTML 不做任何改写 —— 这是我们的文档，`u` 先过一遍 http(s) 校验再拼进 iframe。
	 */
	app.get(WRAPPER_PATH, (request, response) => {
		const raw = typeof request.query.u === "string" ? request.query.u : "";
		// `m=1`：手机模式。外壳里的那一帧要用手机前缀，否则页面拿到的还是电脑版
		const mobile = request.query.m === "1";
		const proxied = raw ? proxyPathOf(raw, { mobile }) : null;
		if (proxied === null) {
			response.status(400).type("text/plain").send("同源外壳需要一个 http / https 的 ?u= 原网址");
			return;
		}
		response.setHeader("cache-control", "no-store");
		response.setHeader("referrer-policy", "no-referrer");
		response.setHeader("x-content-type-options", "nosniff");
		response.type("text/html; charset=utf-8").send(wrapperHtml(proxied, raw));
	});

	// `express.raw` 收原始字节：表单（urlencoded / multipart）要原样转给上游，
	// 交给 `express.json()` 只会得到空对象。挂在这一条路由上，不影响别处的 JSON 解析。
	app.all(/^\/web\/[pm]\//, express.raw({ type: () => true, limit: "8mb" }), (request, response) => {
		void handle(request, response, deps).catch((cause: unknown) => {
			const message = cause instanceof Error ? cause.message : String(cause);
			deps.log(`网页代理出错：${message}`);
			if (!response.headersSent) response.status(502).type("text/plain").send(`代理失败：${message}`);
		});
	});
}

/** `content-encoding` 是压缩的还要自己解：我们请求了 identity，但有的站点就是不理 */
function decodeBody(buffer: Buffer, encoding: string): Buffer {
	try {
		if (!encoding || encoding === "identity") return buffer;
		if (encoding.includes("br")) return brotliDecompressSync(buffer);
		if (encoding.includes("gzip")) return gunzipSync(buffer);
		if (encoding.includes("deflate")) return inflateSync(buffer);
		return buffer;
	} catch {
		// 解不开就当原始字节用：总比整页 500 强（表现是乱码，刷新一次通常就好）
		return buffer;
	}
}

function charsetOf(contentType: string): string {
	const match = /charset=([^;\s]+)/i.exec(contentType);
	return match ? match[1].replace(/["']/g, "") : "utf-8";
}

function textOf(buffer: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset).decode(buffer);
	} catch {
		// 未知 / 拼错的 charset（站点里很常见）：退回 utf-8
		return new TextDecoder("utf-8").decode(buffer);
	}
}

async function handle(request: Request, response: Response, deps: { log: (text: string) => void }): Promise<void> {
	const rawUrl = request.originalUrl;
	const queryAt = rawUrl.indexOf("?");
	const pathname = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
	const search = queryAt < 0 ? "" : rawUrl.slice(queryAt);
	const target = targetOfProxyPath(pathname, search);
	if (!target) {
		response.status(400).type("text/plain").send("只支持 http / https 网页：/web/p/<http|https>/<host>/<path>");
		return;
	}
	/** 这一页走的是手机模式（`/web/m/`）：上游要报手机 UA，改写出来的地址也要留在手机前缀下 */
	const mobile = pathname.startsWith(MOBILE_PREFIX);
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD" && method !== "POST") {
		response.status(405).type("text/plain").send(`网页代理不支持 ${method}`);
		return;
	}

	const headers: Record<string, string> = {
		// 伪装成普通浏览器：不少站点对非浏览器 UA 直接回 403 或极简页面
		// （手机模式下换手机 UA —— 站点按它决定发哪一版，见 MOBILE_UA 上那段）
		"user-agent": mobile ? MOBILE_UA : BROWSER_UA,
		accept: String(request.headers.accept ?? "*/*"),
		"accept-language": String(request.headers["accept-language"] ?? "zh-CN,zh;q=0.9,en;q=0.8"),
		// 跟浏览器一样要压缩：改写的对象是**解压后**的明文（decodeBody 负责解）。
		// 别改成 identity —— 未压缩的 HTML 动辄几百 KB，实测 github.com 会慢到 20 秒
		"accept-encoding": "gzip, deflate, br",
	};
	if (typeof request.headers["content-type"] === "string") headers["content-type"] = request.headers["content-type"];

	const body = method === "POST" ? (request.body as Buffer | undefined) : undefined;
	let upstream: globalThis.Response;
	try {
		upstream = await fetch(target, {
			method,
			headers,
			// 重定向自己处理：跟过去的话文档就不在「镜像路径」下了，页面里的相对地址会全部算错
			redirect: "manual",
			...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		deps.log(`网页代理取不到 ${target}：${message}`);
		response.status(502).type("text/plain").send(`打不开这个网址：${message}`);
		return;
	}

	// 重定向：换成本地代理地址再 302，浏览器跟过去仍在镜像路径下
	if (upstream.status >= 300 && upstream.status < 400) {
		const location = upstream.headers.get("location");
		if (location) {
			const absolute = new URL(location, target).toString();
			const proxied = proxyPathOf(absolute);
			response.redirect(302, proxied ?? absolute);
			return;
		}
	}

	const rawType = upstream.headers.get("content-type") ?? "application/octet-stream";
	const mime = rawType.split(";")[0].trim().toLowerCase();
	const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
	if (declaredLength > MAX_BYTES) {
		response.status(413).type("text/plain").send("这个地址不是网页（文件太大）：点地址栏右边的 ⧉ 用系统浏览器打开");
		return;
	}

	// `Buffer<ArrayBufferLike>` 与 `Buffer<ArrayBuffer>` 在 @types/node 里是两个类型：
	// 显式标出来，后面 decodeBody 的返回值才赋得回去
	let buffer: Buffer = Buffer.from(await upstream.arrayBuffer());
	if (buffer.length > MAX_BYTES) {
		response.status(413).type("text/plain").send("这个地址不是网页（文件太大）：点地址栏右边的 ⧉ 用系统浏览器打开");
		return;
	}
	buffer = decodeBody(buffer, (upstream.headers.get("content-encoding") ?? "").toLowerCase());

	const scope = {
		scheme: new URL(target).protocol.slice(0, -1),
		host: new URL(target).host,
		// 改写出来的地址要跟前缀一致：手机模式的页里点出来的下一页还得是手机模式
		prefix: mobile ? MOBILE_PREFIX : PROXY_PREFIX,
	};

	// 我们自己说了算的头：不抄上游那些会挡住嵌入的（CSP / XFO / COEP），也不落缓存
	response.setHeader("cache-control", "no-store");
	response.setHeader("referrer-policy", "no-referrer");
	response.setHeader("x-content-type-options", "nosniff");
	response.status(upstream.status);

	if (mime === "text/html" || mime === "application/xhtml+xml") {
		const charset = charsetOf(rawType);
		response.setHeader("content-type", `text/html; charset=${charset}`);
		if (method === "HEAD") {
			response.end();
			return;
		}
		response.end(rewriteHtml(textOf(buffer, charset), scope));
		return;
	}

	if (mime === "text/css") {
		const charset = charsetOf(rawType);
		response.setHeader("content-type", `text/css; charset=${charset}`);
		if (method === "HEAD") {
			response.end();
			return;
		}
		response.end(rewriteCss(textOf(buffer, charset), scope));
		return;
	}

	// 其它类型（图片 / 字体 / 脚本 / JSON）：原样吐出去。我们请求了 identity，
	// 所以这里的内容已经是明文，`content-encoding` 也就不能再声明
	response.setHeader("content-type", rawType);
	if (method === "HEAD") {
		response.end();
		return;
	}
	response.end(buffer);
}
