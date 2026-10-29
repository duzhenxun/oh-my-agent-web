/**
 * 附件上传的 HTTP 路由（ADR-0020 §P3）——从 index.ts 抽出（400 行护栏）。
 *
 * 两条路由：
 *   `POST /api/uploads`  原始字节（文件名走 `x-file-name` 头）→ 返回 AttachmentRef
 *   `GET  /api/uploads/:id`  回显（界面内联显示图片；也是消息里 markdown 引用的落点）
 *
 * 刻意用 `express.raw` 而不是 multipart：少一个依赖，而且我们只需要「一堆字节 + 一个文件名」。
 */
import express, { type Express } from "express";
import { isImageMime, MAX_UPLOAD_BYTES, type UploadStore } from "./upload-store.js";
import { applyFileResponseHeaders } from "../http/file-headers.js";

export type Logger = {
	info: (message: string, ctx?: Record<string, unknown>) => void;
	warn: (message: string, ctx?: Record<string, unknown>) => void;
};

/**
 * 纯函数：解出上传文件名。
 *
 * 两种客户端都要伺候（真实踩过：中文名变成 `æªå¾.png`）：
 *   - 百分号编码（我们的前端）→ decodeURIComponent；
 *   - 原样 UTF-8（curl / 其它工具）→ Node 按 **latin1** 解了请求头，得转回 UTF-8。
 */
function decodeFileName(header: string): string {
	const trimmed = header.trim();
	if (trimmed === "") return "粘贴的图片";
	if (/%[0-9a-f]{2}/i.test(trimmed)) {
		try {
			return decodeURIComponent(trimmed);
		} catch {
			// 落回下面的 latin1 → UTF-8 转换
		}
	}
	const recovered = Buffer.from(trimmed, "latin1").toString("utf8");
	return recovered.includes("\uFFFD") ? trimmed : recovered;
}

export function registerUploadRoutes(app: Express, options: { uploadStore: UploadStore; logger: Logger }): void {
	app.post("/api/uploads", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (request, response) => {
		try {
			const bytes = request.body instanceof Uint8Array ? request.body : new Uint8Array();
			const header = request.headers["x-file-name"];
			const name = decodeFileName(typeof header === "string" ? header : "");
			const saved = await options.uploadStore.save({ bytes, declaredMime: request.headers["content-type"], name });
			options.logger.info("收到上传", { id: saved.id, mime: saved.mime, bytes: saved.bytes });
			response.json({
				id: saved.id,
				kind: isImageMime(saved.mime) ? "image" : "file",
				name: saved.name,
				mime: saved.mime,
				bytes: saved.bytes,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.logger.warn("上传被拒", { message });
			response.status(400).json({ error: { code: "upload.rejected", message } });
		}
	});

	app.get("/api/uploads/:id", async (request, response) => {
		const found = await options.uploadStore.read(request.params.id);
		if (!found) {
			response.status(404).json({ error: { code: "upload.not_found", message: "附件不存在或已过期" } });
			return;
		}
		// 附件也走同一套规则（ADR-0042）：上传的 .svg/.html 不能被当成同源页面执行
		applyFileResponseHeaders(request.headers, response, { mime: found.mime, filename: `upload-${request.params.id}` });
		response.type(found.mime).send(found.bytes);
	});
}
