/**
 * ADR-0042：直接回字节的接口（`/api/files/raw`、`/api/files/media`、`/api/uploads/:id`）的公共响应头。
 *
 * 为什么需要：这几个接口把**用户/模型写出来的文件原样**吐回来，而且和工作台**同源**。
 * `text/html` 和 `image/svg+xml` 属于「能执行脚本的文档」—— 在地址栏直接打开
 * `/api/files/raw?path=/tmp/x.html`，它就在工作台同源里跑起来，可以反过来调 `/api`
 * （终端、写文件、改设置），于是「只读地看一眼文件」升级成了任意操作。
 *
 * 但也不能一律 `attachment`，页面自己要用这些字节：
 *   - html 报告走 **iframe**，DOM 上已经 `sandbox="allow-scripts"`（不给 allow-same-origin）；
 *   - 图片 / SVG 走 **`<img>`**，浏览器本来就不执行里面的脚本。
 * 所以按 `Sec-Fetch-Dest` 区分「被页面内嵌」还是「顶层导航」：
 *   - 内嵌（iframe / img / object / embed）：照常渲染，只加 `nosniff`；
 *   - 顶层导航（document），或者**拿不到这个头**（老浏览器 / curl）：转成下载 + CSP sandbox。
 *     宁严不宽：拿不到就按最危险的路径处理，代价只是「点链接会下载一个文件」。
 */
import { basename } from "node:path";

/** `Sec-Fetch-Dest` 里代表「被页面内嵌、且不会以文档身份执行脚本」的取值 */
const EMBEDDED_DESTS = new Set(["iframe", "frame", "object", "embed", "image", "video", "audio", "track"]);

/**
 * 这个 MIME 是不是「打开就能执行脚本」的主动内容。
 *
 * 只认文档类：html / xhtml / svg / 其它 xml。图片（png/jpeg/webp…）不是主动内容，
 * 视频音频也不是 —— 它们该照旧内联，别被误伤。
 */
export function isActiveContentMime(mime: string): boolean {
	const value = mime.toLowerCase();
	if (value.startsWith("text/html")) return true;
	if (value.includes("xhtml")) return true;
	if (value.startsWith("image/svg")) return true; // image/svg+xml
	return /[+/]xml\b/.test(value);
}

/** 请求方是不是「页面内嵌」来的（拿不到 Sec-Fetch-Dest 时按顶层导航处理） */
export function isEmbeddedRequest(headers: Record<string, string | string[] | undefined>): boolean {
	const raw = headers["sec-fetch-dest"];
	const dest = Array.isArray(raw) ? raw[0] : raw;
	if (typeof dest !== "string" || dest === "") return false;
	return EMBEDDED_DESTS.has(dest.toLowerCase());
}

/** `Content-Disposition: attachment` 头。非 ASCII 文件名走 RFC 5987 的 `filename*` */
export function attachmentHeader(filename?: string): string {
	const raw = filename ?? "file";
	// Node 的 setHeader 会拒绝非 ASCII 头值（ERR_INVALID_CHAR），所以 filename= 那份必须是纯 ASCII：
	// 中文名靠后面的 filename* 传（RFC 5987），旧客户端只会看到一个下划线文件名，不会报错
	const name = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_");
	const encoded = encodeURIComponent(raw).replace(/'/g, "%27");
	return `attachment; filename="${name}"; filename*=UTF-8''${encoded}`;
}

type FileResponse = {
	/** 例如 `text/html; charset=utf-8` */
	mime: string;
	/** 只用于下载时的文件名（一般是原始文件名 / 相对路径的最后一段） */
	filename?: string;
};

/**
 * 给「回字节」的响应加公共头。返回是否被强制转成了下载（测试与日志用）。
 *
 * 调用方只需要照旧设置 `Content-Type` / 缓存头 / Range 头，然后调这个函数。
 */
export function applyFileResponseHeaders(
	headers: Record<string, string | string[] | undefined>,
	response: { setHeader(name: string, value: string): void },
	file: FileResponse,
): { downloaded: boolean } {
	// 不许浏览器再猜类型：把图片/媒体嗅探成 html 是经典的同源脚本入口
	response.setHeader("X-Content-Type-Options", "nosniff");

	if (!isActiveContentMime(file.mime)) return { downloaded: false };
	// 页面内嵌（iframe 已 sandbox、<img> 不执行脚本）：保持原样，报告类预览靠它
	if (isEmbeddedRequest(headers)) return { downloaded: false };

	response.setHeader("Content-Disposition", attachmentHeader(file.filename));
	// 双保险：万一浏览器不认 attachment（或被扩展改掉），也不许它加载子资源 / 跑脚本
	response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
	return { downloaded: true };
}

/** 从请求里能拿到的文件名（相对路径的最后一段）；拿不到就给 `file` */
export function filenameOf(relPath: string): string {
	const name = basename(relPath.replace(/\\/g, "/"));
	return name === "" || name === "." || name === ".." ? "file" : name;
}
