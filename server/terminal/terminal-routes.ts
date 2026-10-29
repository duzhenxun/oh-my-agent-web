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
import { dirname, isAbsolute } from "node:path";
import type { Express } from "express";
import { startTerminal, type TerminalSession } from "./terminal-session.js";

export function registerTerminalRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	/**
	 * 多终端注册表（ADR-0027 增补）：每个终端一个 id，互不影响。
	 * 之前是「全局单例」，所以开第二个终端会把第一个杀掉（用户反馈的"切换终端就退出"）。
	 */
	const terminals = new Map<string, { session: TerminalSession; listeners: Set<(chunk: string) => void> }>();
	/** 被重启/关闭过的 id：迟到的 onExit 一律忽略（否则会污染新终端） */
	/**
	 * 每个终端 id 的「代」（generation）：重启 / 停止时 +1，旧 PTY 的退出靠它认出来。
	 *
	 * 为什么不是「丢弃集合」：旧写法在 start 里**无条件**把 id 加进去，于是**新终端自己**的
	 * 第一次退出也会被当成「迟到的旧会话退出」吞掉 —— 用户在终端里敲 `exit`，界面既不提示
	 * 已退出、`terminals` 也不清理，SSE 连接一直挂着（终端看着像假死）。
	 * 改成认代数后：只有「当前这一代」的退出算数，迟到的旧退出自然被丢，新终端的退出不会被误杀。
	 */
	const generation = new Map<string, number>();

	const broadcastFor = (id: string, chunk: string) => {
		const entry = terminals.get(id);
		if (!entry) return;
		for (const listener of entry.listeners) listener(chunk);
	};

	app.post("/api/terminal/start", async (request, response) => {
		const workspace = options.workspaceOf();
		if (!workspace) {
			response
				.status(409)
				.json({ error: { code: "terminal.no_workspace", message: "还没有打开会话（不知道在哪个目录起终端）" } });
			return;
		}
		const body = request.body as { id?: string; cols?: number; rows?: number; cwd?: string } | undefined;
		const id = typeof body?.id === "string" && body.id !== "" ? body.id : `term-${Date.now().toString(36)}`;
		// 同一个 id 重复 start = 重启（例如刷新页面），先收掉旧的
		const previous = terminals.get(id);
		terminals.delete(id);
		if (previous) previous.session.kill();
		// 旧 PTY 的 onExit 是异步的：它可能在新终端注册之后才到达，所以先升一代
		const gen = (generation.get(id) ?? 0) + 1;
		generation.set(id, gen);
		// 指定了 cwd（从项目菜单「在终端中打开」进来）：必须存在且是目录，且以它自身为根
		let root = workspace;
		let cwd = workspace;
		if (typeof body?.cwd === "string" && isAbsolute(body.cwd)) {
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
				onData: (chunk) => broadcastFor(id, chunk),
				onExit: (exitCode) => {
					if (generation.get(id) !== gen) return; // 这条退出属于被重启/停掉的旧会话
					generation.delete(id);
					broadcastFor(id, `\r\n[进程已退出，code=${exitCode}]\r\n`);
					terminals.delete(id);
				},
			},
		});
		if (!result.ok) {
			response.status(503).json({ error: { code: "terminal.start_failed", message: result.error } });
			return;
		}
		terminals.set(id, { session: result.terminal, listeners: new Set() });
		response.json({ ok: true, id, cols: result.terminal.cols(), rows: result.terminal.rows() });
	});

	app.get("/api/terminal/stream", (request, response) => {
		/**
		 * 先判断有没有这个终端，**再**写 200 头。
		 *
		 * 以前是先 `writeHead(200)` + 写 `: connected`，然后才发现终端不存在、又去 `writeHead(404)` ——
		 * 头已经发出去了，Node 直接抛 `ERR_HTTP_HEADERS_SENT`：请求就挂在半开状态，
		 * 前端 EventSource 永远等不到结束，后台日志里多一条没人管的异常。
		 */
		const id = typeof request.query.id === "string" ? request.query.id : ([...terminals.keys()].at(-1) ?? "");
		const entry = terminals.get(id);
		if (!entry) {
			// 204 让 EventSource 别无限重连（404 会被当成失败反复重试）
			response.status(204).end();
			return;
		}
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
		entry.listeners.add(listener);
		request.on("close", () => entry.listeners.delete(listener));
	});

	app.post("/api/terminal/input", (request, response) => {
		const body = request.body as { id?: string; data?: unknown } | undefined;
		const entry = terminals.get(typeof body?.id === "string" ? body.id : "");
		if (typeof body?.data === "string" && entry) entry.session.write(body.data);
		response.json({ ok: true });
	});

	app.post("/api/terminal/resize", (request, response) => {
		const body = request.body as { id?: string; cols?: number; rows?: number } | undefined;
		const entry = terminals.get(typeof body?.id === "string" ? body.id : "");
		if (entry && typeof body?.cols === "number" && typeof body?.rows === "number")
			entry.session.resize(body.cols, body.rows);
		response.json({ ok: true });
	});

	app.post("/api/terminal/stop", (request, response) => {
		const body = request.body as { id?: string } | undefined;
		const id = typeof body?.id === "string" ? body.id : "";
		if (id !== "") {
			// 先升一代：kill 之后那条 onExit 到达时会被当成「过去的」，不会再广播一次
			generation.set(id, (generation.get(id) ?? 0) + 1);
			terminals.get(id)?.session.kill();
			terminals.delete(id);
		}
		response.json({ ok: true });
	});

	// 进程退出时统一收拾（不留孤儿 shell）
	process.on("exit", () => {
		for (const entry of terminals.values()) entry.session.kill();
	});
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
		// 三个平台各用自家的「在文件管理器中定位」命令。每一步都只定位、不执行：
		// 直接 open <path> 遇到 .app/.command 会执行它，这是必须避开的坑。
		if (process.platform === "darwin") {
			spawn("open", ["-R", safe], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "win32") {
			// /select, 后面不能有空格（这是 explorer 的命令行怪癖）；
			// 且 explorer 的退出码恒为 1 —— 不能当失败处理
			spawn("explorer.exe", [`/select,${safe}`], { detached: true, stdio: "ignore" }).unref();
		} else {
			// Linux 没有「选中」这回事，只能把父目录打开
			spawn("xdg-open", [dirname(safe)], { detached: true, stdio: "ignore" }).unref();
		}
		response.json({ ok: true });
	});
}

/** 纯函数式的校验：绝对路径 + 存在 + 是目录 */
async function safeDirectory(cwd: string): Promise<string | null> {
	if (!isAbsolute(cwd)) return null;
	try {
		const real = realpathSync(cwd);
		return statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}
