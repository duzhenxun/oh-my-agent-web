/**
 * 终端的 HTTP + SSE 通道（ADR-0027）。
 *
 * 为什么不用 WS：WS 是「协议单源」（ADR-0004），加 4 条终端消息要动 protocol / 白名单 / 分发，
 * 收益不如成本。终端本质是「一条向前读的字节流 + 几条控制请求」，SSE 正好：
 *   POST /api/terminal/start   起 PTY（cwd = 当前会话工作区）
 *   GET  /api/terminal/stream  SSE：输出流（text/event-stream）
 *   POST /api/terminal/input   键盘输入
 *   POST /api/terminal/resize  窗口尺寸
 *   POST /api/terminal/stop    关掉 PTY
 *
 * 同时只允许 1 个 PTY（ADR-0027 §2）。
 */
import type { Express } from "express";
import { startTerminal, type TerminalSession } from "./terminal-session.js";

export function registerTerminalRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	let session: TerminalSession | null = null;
	const listeners = new Set<(chunk: string) => void>();

	const broadcast = (chunk: string) => {
		for (const listener of listeners) listener(chunk);
	};

	app.post("/api/terminal/start", async (request, response) => {
		const workspace = options.workspaceOf();
		if (!workspace) {
			response
				.status(409)
				.json({ error: { code: "terminal.no_workspace", message: "还没有打开会话（不知道在哪个目录起终端）" } });
			return;
		}
		if (session) {
			session.kill();
			session = null;
		}
		const body = request.body as { cols?: number; rows?: number; cwd?: string } | undefined;
		const result = await startTerminal({
			workspaceRoot: workspace,
			cwd: body?.cwd ?? workspace,
			cols: body?.cols,
			rows: body?.rows,
			handlers: {
				onData: broadcast,
				onExit: (exitCode) => {
					broadcast(`\r\n[进程已退出，code=${exitCode}]\r\n`);
					session = null;
				},
			},
		});
		if (!result.ok) {
			response.status(503).json({ error: { code: "terminal.start_failed", message: result.error } });
			return;
		}
		session = result.terminal;
		response.json({ ok: true, cols: session.cols(), rows: session.rows() });
	});

	app.get("/api/terminal/stream", (request, response) => {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(": connected\n\n");
		const listener = (chunk: string) => {
			// SSE 帧里的换行必须转义，否则浏览器会把一帧拆成两条
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		};
		listeners.add(listener);
		request.on("close", () => listeners.delete(listener));
	});

	app.post("/api/terminal/input", (request, response) => {
		const body = request.body as { data?: unknown } | undefined;
		if (typeof body?.data === "string" && session) session.write(body.data);
		response.json({ ok: true });
	});

	app.post("/api/terminal/resize", (request, response) => {
		const body = request.body as { cols?: number; rows?: number } | undefined;
		if (session && typeof body?.cols === "number" && typeof body?.rows === "number")
			session.resize(body.cols, body.rows);
		response.json({ ok: true });
	});

	app.post("/api/terminal/stop", (_request, response) => {
		session?.kill();
		session = null;
		response.json({ ok: true });
	});

	// 进程退出时统一收拾（不留孤儿 shell）
	process.on("exit", () => session?.kill());
}
