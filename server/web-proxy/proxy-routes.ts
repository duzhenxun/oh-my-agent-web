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
import { proxyPathOf, targetOfProxyPath } from "./proxy-url.js";
import { rewriteCss, rewriteHtml } from "./rewrite.js";

/** 上游响应最多收多大：一屏网页足够，太大说明是下载链接，那种应该走 ⧉ 跳出去 */
const MAX_BYTES = 12 * 1024 * 1024;

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function registerWebProxyRoutes(app: Express, deps: { log: (text: string) => void }): void {
	// `express.raw` 收原始字节：表单（urlencoded / multipart）要原样转给上游，
	// 交给 `express.json()` 只会得到空对象。挂在这一条路由上，不影响别处的 JSON 解析。
	app.all(/^\/web\/p\//, express.raw({ type: () => true, limit: "8mb" }), (request, response) => {
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
	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD" && method !== "POST") {
		response.status(405).type("text/plain").send(`网页代理不支持 ${method}`);
		return;
	}

	const headers: Record<string, string> = {
		// 伪装成普通浏览器：不少站点对非浏览器 UA 直接回 403 或极简页面
		"user-agent": BROWSER_UA,
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

	const scope = { scheme: new URL(target).protocol.slice(0, -1), host: new URL(target).host };

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
