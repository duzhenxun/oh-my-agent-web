/**
 * 会话删除（侧栏 ⋯ → 删除）。
 *
 * 具体怎么删由调用方决定（`deleteSession` 注入）：
 *   - codex：走引擎原生 `thread/delete`（Desktop 里也消失）；
 *   - pi：会话文件改名成 `<名字>.deleted-<时间戳>`（列表里消失，文件还在，可手动改回）。
 *
 * 只接受「当前已知项目里的会话 id」，不接受任意路径。
 */
import type { Express } from "express";

export type SessionDeleteResult =
	| { ok: true; mode: "engine" | "file"; movedTo?: string }
	| { ok: false; error: { code: string; message: string } };

export function registerSessionRoutes(
	app: Express,
	options: { deleteSession: (id: string) => Promise<SessionDeleteResult> },
): void {
	app.post("/api/sessions/delete", async (request, response) => {
		const body = request.body as { id?: unknown } | undefined;
		const id = typeof body?.id === "string" ? body.id : "";
		if (id === "") {
			response.status(400).json({ error: { code: "session.no_id", message: "缺少会话 id" } });
			return;
		}
		const result = await options.deleteSession(id);
		if (!result.ok) {
			const status = result.error.code === "session.not_found" ? 404 : 500;
			response.status(status).json({ error: result.error });
			return;
		}
		response.json({ ok: true, mode: result.mode, ...(result.movedTo ? { movedTo: result.movedTo } : {}) });
	});
}
