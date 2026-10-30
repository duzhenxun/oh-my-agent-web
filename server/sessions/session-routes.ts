/**
 * 会话删除（侧栏 ⋯ → 删除）。
 *
 * 具体怎么删由调用方决定（`deleteSession` 注入）：
 *   - codex：走引擎原生 `thread/delete`（Desktop 里也消失）；
 *   - pi：默认会话文件改名成 `<名字>.deleted-<时间戳>`（列表里消失，文件还在，可手动改回）；
 *     请求里带 `purge: true` 时**真删**（`unlink`）—— 界面上那是一颗单独的「彻底删除」，
 *     两下确认、文案写明不可恢复。
 *
 * 只接受「当前已知项目里的会话 id」，不接受任意路径。
 */
import type { Express } from "express";
import type { DeleteOptions } from "../session/delete-session.js";

export type SessionDeleteResult =
	| { ok: true; mode: "engine" | "file" | "purged" | "gone"; movedTo?: string }
	| { ok: false; error: { code: string; message: string } };

export function registerSessionRoutes(
	app: Express,
	options: { deleteSession: (id: string, deleteOptions?: DeleteOptions) => Promise<SessionDeleteResult> },
): void {
	app.post("/api/sessions/delete", async (request, response) => {
		const body = request.body as { id?: unknown; purge?: unknown } | undefined;
		const id = typeof body?.id === "string" ? body.id : "";
		if (id === "") {
			response.status(400).json({ error: { code: "session.no_id", message: "缺少会话 id" } });
			return;
		}
		// 只有显式 `true` 才是真删：真删不可逆，不能被一个拼错/多传的值打开
		const purge = body?.purge === true;
		const result = await options.deleteSession(id, purge ? { purge } : undefined);
		if (!result.ok) {
			const status = result.error.code === "session.not_found" ? 404 : 500;
			response.status(status).json({ error: result.error });
			return;
		}
		response.json({ ok: true, mode: result.mode, ...(result.movedTo ? { movedTo: result.movedTo } : {}) });
	});
}
