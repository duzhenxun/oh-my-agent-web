/**
 * 文件浏览的 HTTP 路由（M4）——从 index.ts 抽出（400 行护栏）。
 *
 *   `GET /api/files/list?path=<相对路径>` → 列一层目录（懒惰展开）
 *   `GET /api/files/read?path=<相对路径>` → 只读预览（≤512KB，二进制给标记）
 *
 * `workspaceOf()` 返回**当前会话**的工作区（多项目：文件树跟着当前会话走，ADR-0021 §3）。
 */
import { realpathSync, statSync } from "node:fs";
import type { Express } from "express";
import { listDirectory, readPreview, readRaw } from "./file-service.js";

export function registerFileRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	app.get("/api/files/list", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await listDirectory(root, relPath);
		if (!result.ok) {
			response.status(400).json({ error: { code: "files.list_failed", message: result.error } });
			return;
		}
		response.json(result);
	});

	// markdown 图片用：直接回字节（只放行图片/PDF 白名单，仍受工作区约束）
	app.get("/api/files/raw", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await readRaw(root, relPath);
		if (!result.ok) {
			response.status(result.tooLarge ? 413 : 400).json({ error: { code: "files.raw_failed", message: result.error } });
			return;
		}
		response.setHeader("Content-Type", result.mime);
		response.setHeader("Cache-Control", "private, max-age=60");
		response.send(result.bytes);
	});

	app.get("/api/files/read", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await readPreview(root, relPath);
		if (!result.ok) {
			response.status(400).json({ error: { code: "files.read_failed", message: result.error } });
			return;
		}
		response.json(result);
	});
}

/**
 * 文件根目录：默认是当前会话的工作区；「在文件中打开」某个项目时传 root 覆盖。
 * 校验：必须是存在的目录（realpath）。不做工作区包含检查 —— 因为根目录本身就是工作区，
 * 一旦允许换根，"包含于工作区"就退化成"包含于自己"，没有意义；真正的边界是**只读**。
 */
function rootOf(raw: unknown, fallback: string | null): string | null {
	if (typeof raw !== "string" || !raw.startsWith("/")) return fallback;
	try {
		const real = realpathSync(raw);
		return statSync(real).isDirectory() ? real : fallback;
	} catch {
		return fallback;
	}
}
