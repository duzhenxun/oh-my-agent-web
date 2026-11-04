/**
 * 文本响应压缩（gzip）+ 静态资源长缓存。
 *
 * 为什么自己写而不是引 `compression` 包：依赖预算（ADR-0008/0029）已经很紧，
 * 而这里只需要「把 text/json/js/css/svg 的响应体 gzip 一下」这一件事，zlib 就够。
 *
 * 实测背景：外网打开慢，主包 1.0MB 且**未压缩**、`Cache-Control: public, max-age=0`，
 * 每次访问都要重新拉一遍 —— 这两条一起改，首屏传输量降到 1/3 左右。
 */
import { gzipSync } from "node:zlib";
import type { NextFunction, Request, Response } from "express";

const TEXT_TYPE = /text|javascript|json|svg|css|xml/i;

export function compressText() {
	return (request: Request, response: Response, next: NextFunction): void => {
		const accept = String(request.headers["accept-encoding"] ?? "");
		// SSE 与文件字节流不能攒也不能压：
		//   - SSE 攒着等于永远不发送（终端输出同理）；
		//   - 视频/音频要支持 Range 拖动，整块进内存会直接把进程吃爆。
		const streamy =
			request.path === "/api/events" ||
			request.path.startsWith("/api/terminal/stream") ||
			// 订阅登录（OAuth）的 SSE：攒到最后等于让用户干等一个登录流程
			request.path.startsWith("/api/subscriptions/") ||
			request.path === "/api/files/media" ||
			request.path === "/api/files/raw" ||
			/**
			 * 「完整历史」：pi 的导出页是**一整页 HTML**，大会话能到几十 MB（实测 33MB 会话 → 45MB 页）。
			 * 这里攒包 + `gzipSync` 是同步的：一次点击会把整个服务（含所有 SSE）卡住 1～2 秒，
			 * 比不压还慢（本机 / 局域网传输本来就不慢）。不压，直接回。
			 */
			/^\/api\/sessions\/[^/]+\/history$/.test(request.path);
		if (!/gzip/i.test(accept) || streamy) {
			next();
			return;
		}

		const chunks: Buffer[] = [];
		const originalEnd = response.end.bind(response);
		let handled = false;

		// 先把响应体攒起来，结束时统一压（单用户工作台，内存里攒一个包没问题）
		response.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			const callback = rest.find((item) => typeof item === "function") as (() => void) | undefined;
			callback?.();
			return true;
		}) as typeof response.write;

		response.end = ((chunk?: unknown, ...rest: unknown[]) => {
			if (handled) return response;
			handled = true;
			if (chunk && typeof chunk !== "function") {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			}
			const body = Buffer.concat(chunks);
			const type = String(response.getHeader("content-type") ?? "");
			const alreadyEncoded = response.getHeader("content-encoding") !== undefined;
			// HEAD / 204 / 304 没有实体：不能把 content-length 改成 0（那是在撒谎，
			// 也会让 HEAD 拿不到真实长度）；express.static 已经设好的长度要留着。
			const status = response.statusCode;
			const noBody = request.method === "HEAD" || status === 204 || status === 304;
			const hadLength = response.getHeader("content-length") !== undefined;

			if (noBody || alreadyEncoded || !TEXT_TYPE.test(type) || body.length < 1024) {
				if (!noBody && !(body.length === 0 && hadLength)) {
					response.setHeader("content-length", String(body.length));
				}
				return originalEnd(body, ...(rest as never[]));
			}

			const gzipped = gzipSync(body, { level: 6 });
			response.setHeader("content-encoding", "gzip");
			response.setHeader("vary", "accept-encoding");
			response.setHeader("content-length", String(gzipped.length));
			return originalEnd(gzipped, ...(rest as never[]));
		}) as typeof response.end;

		next();
	};
}

/** 带哈希的构建产物可以长缓存：文件名变了 URL 就变，不会读到旧内容 */
export function immutableAssets() {
	return (request: Request, response: Response, next: NextFunction): void => {
		if (request.path.startsWith("/assets/")) {
			response.setHeader("cache-control", "public, max-age=31536000, immutable");
			next();
			return;
		}
		/**
		 * 图标那几份（`/favicon.svg?v=4`、`/favicon.ico?v=4`、`/icons/…`）。
		 *
		 * 为什么要单独给长缓存：`express.static` 默认是 `public, max-age=0`，于是**每次都回来验一次**。
		 * 而 Chrome 在地址栏一变（切会话就是 `history.replaceState`）时会把标签页图标重取一遍
		 * （`favicon.svg?v=4` + `favicon.ico?v=4` 各一发，实测如此）—— 表现为「每切一次会话就拉一次 ico」，
		 * DevTools 里一屏 304（用户截图报的就是这个）。
		 *
		 * 安全的前提：**换图必须先换 URL** —— `web/index.html` 与 `src/brand-name.ts` 里一律写成
		 * `/favicon.svg?v=4`，改图案时把 `v` 加一（这条约定本来就有，见 index.html 的注释）。
		 * 没带 `?v=` 的请求（直接手敲 `/favicon.ico`）还是走默认的短缓存，不能靠它换图。
		 */
		if (VERSIONED_ICON.test(request.path) && typeof request.query.v === "string") {
			response.setHeader("cache-control", "public, max-age=31536000, immutable");
		}
		next();
	};
}

/** 产品自带的图标（URL 里一定带 `?v=`）：见 `immutableAssets` 那段注释 */
const VERSIONED_ICON = /^\/(?:favicon(?:-32)?\.(?:ico|svg|png)|maskable\.svg|apple-touch-icon(?:-precomposed)?\.png|icons\/[\w.-]+\.png)$/;
