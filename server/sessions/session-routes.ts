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

/** 「完整历史」/「系统提示词」的结果（失败时带一个可读的 code，界面直接显示 message） */
export type SessionViewResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export function registerSessionRoutes(
	app: Express,
	options: {
		deleteSession: (id: string, deleteOptions?: DeleteOptions) => Promise<SessionDeleteResult>;
		/**
		 * 「完整历史」：整份会话导出成 HTML。**不传就不挂这条路由**
		 * （界面按 `capabilities.historyExport` 决定画不画入口）。
		 */
		sessionHistory?: (id: string) => Promise<SessionViewResult<string>>;
		/** 「系统提示词」：本次运行实际拼出的那段；不传就不挂 */
		sessionSystemPrompt?: (id: string) => Promise<SessionViewResult<string>>;
	},
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

	/** 失败时的状态码：引擎不支持 / 这功能没接 → 400；会话找不到 → 404；导出出错 → 500 */
	const statusOf = (code: string): number => {
		if (code === "engine.unsupported" || code === "session.no_id") return 400;
		if (code === "session.not_found") return 404;
		return 500;
	};

	/**
	 * 「完整历史」失败时回给浏览器的页面：它就嵌在右侧面板的 iframe 里，
	 * 回一包 JSON 的话用户看到的就是一串花括号 —— 这里给一句人话（带状态码）。
	 */
	const errorPage = (status: number, message: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>完整历史</title>
<style>
	html,body{height:100%;margin:0}
	body{display:flex;align-items:center;justify-content:center;padding:24px;
		font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
		color:#8a8f98;background:#fff;color-scheme:light dark}
	@media (prefers-color-scheme:dark){body{color:#8a8f98;background:#16171a}}
	.box{max-width:520px;text-align:center}
	.title{font-size:15px;color:inherit;margin-bottom:6px;font-weight:600}
	.code{font-size:12px;opacity:.6}
</style></head>
<body><div class="box"><div class="title">${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</div>
<div class="code">HTTP ${status}</div></div></body></html>`;

	/**
	 * 「完整历史」：直接把 pi 导出的 HTML 页面吐给浏览器。
	 *
	 * 为什么走 HTTP 而不是塞进快照：那是**一整页独立文档**（自己的 CSS / JS / 高亮），
	 * 进快照就等于每次推 300KB 的字符串，而且前端还得手动拼完整页。
	 */
	if (options.sessionHistory) {
		app.get("/api/sessions/:id/history", async (request, response) => {
			const id = String(request.params.id ?? "");
			if (id === "") {
				response.status(400).json({ error: { code: "session.no_id", message: "缺少会话 id" } });
				return;
			}
			const result = await options.sessionHistory?.(id);
			if (!result) {
				const message = "当前引擎没有「完整历史」";
				response.status(400).type("html").send(errorPage(400, message));
				return;
			}
			if (!result.ok) {
				const status = statusOf(result.error.code);
				response.status(status).type("html").send(errorPage(status, result.error.message));
				return;
			}
			// 同一源下 iframe 里看：**不能带 X-Frame-Options / CSP frame-ancestors**
			// （pi 自己的导出会带 DENY，那是给「下载下来单独打开」用的）
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.setHeader("cache-control", "no-store");
			response.send(result.value);
		});
	}

	/** 「系统提示词」：纯文本 + 一小包元信息，界面直接渲染 */
	if (options.sessionSystemPrompt) {
		app.get("/api/sessions/:id/system-prompt", async (request, response) => {
			const id = String(request.params.id ?? "");
			if (id === "") {
				response.status(400).json({ error: { code: "session.no_id", message: "缺少会话 id" } });
				return;
			}
			const result = await options.sessionSystemPrompt?.(id);
			if (!result) {
				response.status(400).json({ error: { code: "engine.unsupported", message: "当前引擎看不到系统提示词" } });
				return;
			}
			if (!result.ok) {
				response.status(statusOf(result.error.code)).json({ error: result.error });
				return;
			}
			response.setHeader("cache-control", "no-store");
			response.json({ prompt: result.value });
		});
	}
}
