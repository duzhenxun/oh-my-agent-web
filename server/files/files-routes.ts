/**
 * 文件浏览的 HTTP 路由（M4）——从 index.ts 抽出（400 行护栏）。
 *
 *   `GET /api/files/list?path=<相对路径>` → 列一层目录（懒惰展开）
 *   `GET /api/files/read?path=<相对路径>` → 只读预览（≤512KB，二进制给标记）
 *
 * `workspaceOf()` 返回**当前会话**的工作区（多项目：文件树跟着当前会话走，ADR-0021 §3）。
 */
import type { Express } from "express";
import { listDirectory, readPreview } from "./file-service.js";

export function registerFileRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	app.get("/api/files/list", async (request, response) => {
		const root = options.workspaceOf();
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

	app.get("/api/files/read", async (request, response) => {
		const root = options.workspaceOf();
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
