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
 *
 * 依赖位置：node-pty 在 package.json 的 **optionalDependencies** 里（不在 dependencies）。
 *   - 它是原生模块，Linux 上没编译器时整包 `npm install` 会失败，而终端只是其中一个面板；
 *   - 下面 `await import("node-pty")` 已经把它写成**可缺失**的分支（失败→返回「终端不可用」，服务照常起）；
 *   - 副作用：`npm i --omit=optional` 现在真能跳过它的 64MB 预编译产物，而服务不会因此装不上。
 */
import { resolveInsideRoot } from "../util/paths.js";
import { findExecutable } from "../util/spawn-cli.js";
import { realpathSync } from "node:fs";

const OUTPUT_FLUSH_MS = 30;
const MAX_CHUNK_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

/** 纯函数：把前端报上来的尺寸夹到合法区间（防止 0 列导致 PTY 崩） */
function clampSize(cols: number, rows: number): { cols: number; rows: number } {
	const safeCols = Number.isFinite(cols) ? Math.floor(cols) : 80;
	const safeRows = Number.isFinite(rows) ? Math.floor(rows) : 24;
	return {
		cols: Math.min(Math.max(safeCols, MIN_COLS), MAX_COLS),
		rows: Math.min(Math.max(safeRows, MIN_ROWS), MAX_ROWS),
	};
}

/**
 * 纯函数：选 shell 与它的启动参数。
 *
 * 不能只挑一个路径：`-l`（login shell）是 POSIX 的参数，cmd / PowerShell 不认；
 * 反过来 PowerShell 要的是 `-NoLogo`。所以这里返回 `{ file, args }`。
 */
function resolveShell(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	find: (bin: string) => string | null = (bin) => findExecutable(bin, env, platform),
): { file: string; args: string[] } {
	if (platform === "win32") {
		// pwsh（PS 7）优先，退内置 Windows PowerShell，再退 cmd
		for (const bin of ["pwsh.exe", "powershell.exe"]) {
			const found = find(bin);
			if (found !== null) return { file: found, args: ["-NoLogo"] };
		}
		return { file: env.COMSPEC ?? env.ComSpec ?? "cmd.exe", args: [] };
	}
	return { file: env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l"] };
}

/** 纯函数：给 shell 的最小环境（不透传内部变量，不继承可能的密钥） */
function shellEnv(
	base: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	// Windows 少一个 SystemRoot，PowerShell 直接起不来，而且报错完全指不到点子上，
	// 所以这份白名单必须按平台分开 —— 只留 POSIX 那套等于在 Windows 上起不来终端。
	const keep = [
		"HOME",
		"PATH",
		"SHELL",
		"USER",
		"LOGNAME",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		...(platform === "win32"
			? [
					"SystemRoot", // ← 缺了它连 winsock 都初始化不了
					"SystemDrive",
					"windir",
					"COMSPEC",
					"PATHEXT",
					"USERPROFILE",
					"HOMEDRIVE",
					"HOMEPATH",
					"APPDATA",
					"LOCALAPPDATA",
					"TEMP",
					"TMP",
					"ProgramFiles",
					"ProgramData",
					"NUMBER_OF_PROCESSORS",
				]
			: []),
	];
	const env: Record<string, string> = {};
	// conpty 自己会告诉对面终端类型，不需要我们指定（指定了反而掩盖真实值）
	if (platform !== "win32") env.TERM = "xterm-256color";
	for (const key of keep) {
		const value = base[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	return env;
}

type TerminalHandlers = {
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

type StartResult = { ok: true; terminal: TerminalSession } | { ok: false; error: string };

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
	const shell = resolveShell();
	let pty: import("node-pty").IPty;
	try {
		pty = spawn(shell.file, shell.args, {
			name: process.platform === "win32" ? undefined : "xterm-256color",
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
