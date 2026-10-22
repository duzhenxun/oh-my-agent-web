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
			request.path === "/api/files/media" ||
			request.path === "/api/files/raw";
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
		}
		next();
	};
}
