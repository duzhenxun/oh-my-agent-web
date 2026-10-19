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
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
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
		// 指定了 cwd（从项目菜单「在终端中打开」进来）：必须存在且是目录，且以它自身为根
		let root = workspace;
		let cwd = workspace;
		if (typeof body?.cwd === "string" && body.cwd.startsWith("/")) {
			try {
				const real = realpathSync(body.cwd);
				if (statSync(real).isDirectory()) {
					root = real;
					cwd = real;
				}
			} catch {
				// 路径不可用 → 回落到当前工作区
			}
		}
		const result = await startTerminal({
			workspaceRoot: root,
			cwd,
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

/**
 * 「在文件中打开」/「在终端中打开」的支撑（ADR-0027 增补）。
 *
 * 安全边界（刻意保守）：
 *   - **只接受绝对路径**，且 realpath 后必须存在、必须是目录；
 *   - 「在文件中打开」用 `open -R`（**只定位、不执行**）：直接 `open <path>` 遇到 .app/.command
 *     会**执行**它，这是必须避开的坑；
 *   - 不读目录内容、不返回任何文件信息，只回 ok。
 */
export function registerProjectActions(app: Express, _options: { workspaceOf: () => string | null }): void {
	app.post("/api/projects/reveal", async (request, response) => {
		const cwd =
			typeof (request.body as { cwd?: unknown } | undefined)?.cwd === "string"
				? String((request.body as { cwd: string }).cwd)
				: "";
		const safe = await safeDirectory(cwd);
		if (!safe) {
			response.status(400).json({ error: { code: "project.bad_path", message: "不是可用的目录路径" } });
			return;
		}
		if (process.platform !== "darwin") {
			response.status(501).json({ error: { code: "project.unsupported", message: "当前平台暂不支持" } });
			return;
		}
		// -R = 在 Finder 里定位，不执行
		spawn("open", ["-R", safe], { detached: true, stdio: "ignore" }).unref();
		response.json({ ok: true });
	});
}

/** 纯函数式的校验：绝对路径 + 存在 + 是目录 */
async function safeDirectory(cwd: string): Promise<string | null> {
	if (!cwd.startsWith("/")) return null;
	try {
		const real = realpathSync(cwd);
		return statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}
