/**
 * 终端会话（ADR-0027）：尺寸夹取、最小环境、cwd 越界拒绝。
 * 用注入的假 spawn —— 单测不真起 shell（零端口、零进程，ADR-0009 第 1 层）。
 */
import { describe, expect, it } from "vitest";
import {
	clampSize,
	MAX_COLS,
	MAX_ROWS,
	MIN_COLS,
	MIN_ROWS,
	shellEnv,
	startTerminal,
} from "../../server/terminal/terminal-session.js";

describe("clampSize", () => {
	it("区间内原样，越界夹住", () => {
		expect(clampSize(120, 40)).toEqual({ cols: 120, rows: 40 });
		expect(clampSize(1, 1)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
		expect(clampSize(9999, 9999)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
	});

	it("NaN 回落到 80x24（不是 0 列，0 列会让 PTY 崩）", () => {
		expect(clampSize(Number.NaN, Number.NaN)).toEqual({ cols: 80, rows: 24 });
	});
});

describe("shellEnv", () => {
	it("只保留必需变量，内部变量与密钥一律不透传", () => {
		const env = shellEnv({
			HOME: "/Users/x",
			PATH: "/usr/bin",
			TERM: "dumb",
			AGENT_WEB_DATA_DIR: "/secret",
			OPENAI_API_KEY: "sk-should-not-leak",
		});
		expect(env.TERM).toBe("xterm-256color");
		expect(env.HOME).toBe("/Users/x");
		expect(env.DATA_DIR).toBeUndefined();
		expect(JSON.stringify(env)).not.toContain("sk-should-not-leak");
		expect(JSON.stringify(env)).not.toContain("/secret");
	});
});

describe("startTerminal", () => {
	const fakeSpawn = (calls: unknown[]) => () => {
		const handlers: Array<(data: string) => void> = [];
		let exit: ((event: { exitCode: number }) => void) | null = null;
		calls.push(handlers);
		return {
			onData: (fn: (data: string) => void) => handlers.push(fn),
			onExit: (fn: (event: { exitCode: number }) => void) => {
				exit = fn;
			},
			write: () => {},
			resize: () => {},
			kill: () => exit?.({ exitCode: 0 }),
		} as never;
	};

	it("cwd 越界（跑到工作区外）直接拒绝，不起 shell", async () => {
		const calls: unknown[] = [];
		const result = await startTerminal({
			workspaceRoot: "/tmp/agent-web-ws",
			cwd: "/etc",
			handlers: { onData: () => {}, onExit: () => {} },
			spawnImpl: fakeSpawn(calls) as never,
		});
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("工作区内能起，输出按批推送（节流合并）", async () => {
		const calls: unknown[] = [];
		const chunks: string[] = [];
		const result = await startTerminal({
			workspaceRoot: "/tmp",
			cwd: "/tmp",
			handlers: { onData: (chunk) => chunks.push(chunk), onExit: () => {} },
			spawnImpl: fakeSpawn(calls) as never,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const emit = (calls[0] as Array<(data: string) => void>)[0];
		emit?.("hello ");
		emit?.("world");
		expect(chunks).toHaveLength(0); // 还没到 30ms，不该立刻推
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(chunks.join("")).toBe("hello world");
		result.terminal.kill();
	});
});
