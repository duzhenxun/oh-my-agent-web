/**
 * 终端会话（ADR-0027）：一个 PTY + 输出节流。
 *
 * 为什么必须是 PTY（node-pty）而不是 child_process.spawn：
 *   vim / top / Ctrl-C / 颜色 / 行编辑，全都依赖"对面是个终端"。用管道跑出来的东西
 *   在真实使用里几乎不可用（vim 会直接报错），所以这条依赖是必要的。
 *
 * 安全与稳定的三条硬约束：
 *   1. cwd 由调用方给定，**只允许在工作区内**（由调用方用 resolveInsideRoot 保证）；
 *   2. 环境变量最小化，不把 AGENT_WEB_* 之类内部变量透传给 shell；
 *   3. 输出**节流合并**（30ms 一批、单批 ≤64KB），否则 `yes` 一条命令就能把进程打爆。
 */
import { resolveInsideRoot } from "../util/paths.js";
import { realpathSync } from "node:fs";

export const OUTPUT_FLUSH_MS = 30;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MIN_COLS = 20;
export const MAX_COLS = 400;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

/** 纯函数：把前端报上来的尺寸夹到合法区间（防止 0 列导致 PTY 崩） */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
	const safeCols = Number.isFinite(cols) ? Math.floor(cols) : 80;
	const safeRows = Number.isFinite(rows) ? Math.floor(rows) : 24;
	return {
		cols: Math.min(Math.max(safeCols, MIN_COLS), MAX_COLS),
		rows: Math.min(Math.max(safeRows, MIN_ROWS), MAX_ROWS),
	};
}

/** 纯函数：给 shell 的最小环境（不透传内部变量，不继承可能的密钥） */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const keep = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]; // TERM 必须在下面强制
	const env: Record<string, string> = { TERM: "xterm-256color" };
	for (const key of keep) {
		const value = base[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	return env;
}

export type TerminalHandlers = {
	/** 一批输出（已节流合并，可能被截断） */
	onData: (chunk: string) => void;
	/** PTY 退出 */
	onExit: (exitCode: number) => void;
};

export type TerminalSession = {
	write: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	kill: () => void;
	cols: () => number;
	rows: () => number;
};

export type StartResult = { ok: true; terminal: TerminalSession } | { ok: false; error: string };

/**
 * 起一个 PTY。`workspaceRoot` 用来兜底 cwd：即使在别处被误用，也不会在任意目录开 shell。
 */
export async function startTerminal(options: {
	workspaceRoot: string;
	cwd: string;
	cols?: number;
	rows?: number;
	handlers: TerminalHandlers;
	/** 测试注入用 */
	spawnImpl?: typeof import("node-pty").spawn;
}): Promise<StartResult> {
	const safe = resolveInsideRoot(options.workspaceRoot, options.cwd, realpathSync);
	if (!safe.ok) return { ok: false, error: safe.reason };

	let spawn = options.spawnImpl;
	if (!spawn) {
		try {
			// 动态 import：node-pty 是原生模块，装不上时整个服务不该崩（ADR-0027 §影响）
			spawn = (await import("node-pty")).spawn;
		} catch (error) {
			return {
				ok: false,
				error: `终端不可用（node-pty 未安装或编译失败）：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const size = clampSize(options.cols ?? 80, options.rows ?? 24);
	const shell = process.env.SHELL ?? "/bin/zsh";
	let pty: import("node-pty").IPty;
	try {
		pty = spawn(shell, ["-l"], {
			name: "xterm-256color",
			cwd: safe.path,
			env: shellEnv(),
			cols: size.cols,
			rows: size.rows,
		});
	} catch (error) {
		return { ok: false, error: `起 shell 失败：${error instanceof Error ? error.message : String(error)}` };
	}

	// 输出节流：攒到 30ms 再一起推，单批超 64KB 截断（宁可丢显示，不能拖垮进程）
	let buffer = "";
	let timer: NodeJS.Timeout | null = null;
	let killed = false;
	const flush = () => {
		timer = null;
		if (buffer === "") return;
		const chunk =
			buffer.length > MAX_CHUNK_BYTES ? `${buffer.slice(0, MAX_CHUNK_BYTES)}\r\n[输出过快，已截断]\r\n` : buffer;
		buffer = "";
		options.handlers.onData(chunk);
	};

	pty.onData((data) => {
		if (killed) return;
		buffer += data;
		if (buffer.length > MAX_CHUNK_BYTES * 4) {
			// 前端根本不读时别无限攒内存：直接丢到上限
			buffer = buffer.slice(-MAX_CHUNK_BYTES);
		}
		if (timer === null) timer = setTimeout(flush, OUTPUT_FLUSH_MS);
	});
	pty.onExit(({ exitCode }) => {
		killed = true;
		if (timer !== null) clearTimeout(timer);
		timer = null;
		flush();
		options.handlers.onExit(exitCode);
	});

	return {
		ok: true,
		terminal: {
			write: (data) => {
				if (!killed) pty.write(data);
			},
			resize: (cols, rows) => {
				if (killed) return;
				const next = clampSize(cols, rows);
				try {
					pty.resize(next.cols, next.rows);
				} catch {
					// 已经退出的 PTY resize 会抛，忽略即可
				}
			},
			kill: () => {
				if (killed) return;
				killed = true;
				try {
					pty.kill();
				} catch {
					// 幂等
				}
			},
			cols: () => size.cols,
			rows: () => size.rows,
		},
	};
}
