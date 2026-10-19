/**
 * 会话删除（侧栏 ⋯ → 删除）。
 *
 * **不做真删**：把会话文件改名成 `<名字>.deleted-<时间戳>`，pi 扫描不到（列表里消失），
 * 但文件还在磁盘上 —— 误删可以手动改回来。真删是另一个决定（要废纸篓/二次确认链路）。
 *
 * 只接受「当前已知项目里的会话 id」，不接受任意路径。
 */
import { rename } from "node:fs/promises";
import type { Express } from "express";
import type { PiProject } from "../protocol.js";

export function registerSessionRoutes(app: Express, options: { projects: () => PiProject[] }): void {
	app.post("/api/sessions/delete", async (request, response) => {
		const body = request.body as { id?: unknown } | undefined;
		const id = typeof body?.id === "string" ? body.id : "";
		if (id === "") {
			response.status(400).json({ error: { code: "session.no_id", message: "缺少会话 id" } });
			return;
		}
		const session = options
			.projects()
			.flatMap((project) => project.sessions)
			.find((item) => item.id === id);
		if (!session || !session.sessionPath) {
			response.status(404).json({ error: { code: "session.not_found", message: "找不到这条会话（可能已被清理）" } });
			return;
		}
		const target = `${session.sessionPath}.deleted-${Date.now()}`;
		try {
			await rename(session.sessionPath, target);
		} catch (error) {
			response.status(500).json({
				error: { code: "session.delete_failed", message: error instanceof Error ? error.message : String(error) },
			});
			return;
		}
		response.json({ ok: true, movedTo: target });
	});
}
