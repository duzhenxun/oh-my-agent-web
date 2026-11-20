#!/usr/bin/env node
/**
 * 电脑控制 CLI：给 Skill 里的 bash 调用（任何能跑 bash 的引擎都能用）。
 *
 *   node dist/server/computer/cli.js status
 *   node dist/server/computer/cli.js observe Safari
 *   node dist/server/computer/cli.js click Safari --element 12
 *
 * 输出一行 JSON 到 stdout：成功 `{"ok":true,"result":...}`，失败 `{"ok":false,"error":{...}}` 且退出码为 1。
 * 动作语义与 agent-computer-turbo 的 MCP 工具一致（参数名一一对应，见 server.mjs 的 STEP_BUILDERS）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HelperClient, HelperError, type HelperSession } from "./helper-client.js";
import { socketPath } from "./paths.js";

type Flags = Record<string, string | true>;

const USAGE = `电脑控制 CLI（需要本机 Agent Computer helper 在运行）

用法：node <cli.js> <命令> [参数] [--选项 值]

  status                              helper 运行状态与权限
  access [--request]                  权限检查；--request 会弹系统授权提示
  apps                                列出应用
  observe <应用> [--full]             界面树 + 截图
  click <应用> --element N            按编号点击（或 --x X --y Y 用截图像素）
  type <应用> <文字> [--element N]    输入文字
  keys <应用> <组合键>                按键，如 cmd+s
  fill <应用> --element N --value V   替换输入框内容
  paste <应用> <文字> [--format text|markdown|html]
  scroll <应用> <up|down|left|right> [--element N] [--pages N]
  drag <应用> --from X,Y --to X,Y     拖拽（截图像素）
  invoke <应用> --element N --name 名 执行无障碍动作
  commands <应用> [--query 词]        列出菜单命令
  run-command <应用> "菜单 ▸ 命令"    执行菜单命令
  wait <应用> --until X [--text T] [--element N] [--timeout 10]
  preview <on|off>                    实时预览浮窗
  finish                              结束操作会话
`;

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags } {
	const positionals: string[] = [];
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] ?? "";
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = true;
			}
		} else {
			positionals.push(token);
		}
	}
	return { positionals, flags };
}

function requireText(value: string | undefined, what: string): string {
	if (value === undefined || value === "") throw new HelperError("badArguments", `缺少参数：${what}`);
	return value;
}

function intFlag(flags: Flags, key: string): number | undefined {
	const raw = flags[key];
	if (raw === undefined) return undefined;
	if (raw === true) throw new HelperError("badArguments", `--${key} 需要一个值`);
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) throw new HelperError("badArguments", `--${key} 必须是非负整数`);
	return n;
}

function stringFlag(flags: Flags, key: string): string | undefined {
	const raw = flags[key];
	if (raw === undefined) return undefined;
	if (raw === true) throw new HelperError("badArguments", `--${key} 需要一个值`);
	return raw;
}

/** 点击/滚动的目标：--element（优先）或 --x --y（截图像素），二选一 */
function targetFrom(flags: Flags): Record<string, number> {
	const element = intFlag(flags, "element");
	const x = flags.x === undefined ? undefined : Number(flags.x);
	const y = flags.y === undefined ? undefined : Number(flags.y);
	if (element !== undefined && (x !== undefined || y !== undefined)) {
		throw new HelperError("badArguments", "只能指定 --element，或者 --x 与 --y，不能同时指定");
	}
	if (element !== undefined) return { elementNumber: element };
	if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
	throw new HelperError("badArguments", "请指定 --element N，或同时指定 --x 与 --y（截图像素）");
}

/** 菜单路径：支持 `文件 ▸ 存储`、`File > Save`、`File → Save` */
export function parseCommandPath(text: string): string[] {
	const parts = text.includes("▸") ? text.split("▸") : text.split(/\s+>\s+|\s*→\s*/);
	const path = parts.map((p) => p.trim()).filter(Boolean);
	if (path.length < 2) {
		throw new HelperError("badArguments", `「${text}」不是菜单路径，请写成「菜单 ▸ 命令」，可先用 commands 查看`);
	}
	if (path.length > 8) throw new HelperError("badArguments", "菜单路径最多 8 级");
	return path;
}

/** 本会话的稳定 ID：helper 用它关联同一段操作，所以一台机器只生成一次并保存 */
function stableSessionId(): string {
	const override = process.env.OMAW_COMPUTER_SESSION?.trim();
	if (override) return override;
	const dir = join(homedir(), ".oh-my-agent-web", "agent-computer");
	const file = join(dir, "session-id");
	if (existsSync(file)) {
		const existing = readFileSync(file, "utf8").trim();
		if (existing) return existing;
	}
	const id = randomUUID();
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${id}\n`, "utf8");
	return id;
}

/** 祖先进程 pid（helper 据此认出「宿主应用」并保护它不被误操作） */
function ancestorPids(): number[] {
	const pids: number[] = [];
	let pid = process.ppid;
	for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
		pids.push(pid);
		try {
			const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
			pid = Number(out);
		} catch {
			break;
		}
		if (!Number.isFinite(pid)) break;
	}
	return pids;
}

function buildSession(): HelperSession {
	return {
		sessionId: stableSessionId(),
		turnId: null,
		agent: { name: process.env.CUT_AGENT_NAME?.trim() || "oh-my-agent-web", ancestorPids: ancestorPids() },
	};
}

/** 执行一个命令，返回要打印的 result */
async function run(command: string, positionals: string[], flags: Flags, client: HelperClient): Promise<unknown> {
	if (command === "status") {
		const hello = await client.connect();
		return { running: true, helperVersion: hello.helperVersion ?? null, permissions: hello.permissions ?? {} };
	}
	await client.connect();

	switch (command) {
		case "access":
			return client.request(flags.request === true ? "requestAccess" : "accessStatus", {});
		case "apps":
			return client.request("findApps", {});
		case "observe": {
			const app = requireText(positionals[0], "应用名");
			return client.request("observeApp", { app, fullTree: flags.full === true, includeScreenshot: true });
		}
		case "click": {
			const app = requireText(positionals[0], "应用名");
			const button = stringFlag(flags, "button");
			const times = intFlag(flags, "times");
			return act(client, app, { type: "clickAt", ...targetFrom(flags), button, clickTimes: times });
		}
		case "type": {
			const app = requireText(positionals[0], "应用名");
			const text = requireText(positionals[1], "文字");
			return act(client, app, { type: "writeText", text, elementNumber: intFlag(flags, "element") });
		}
		case "keys": {
			const app = requireText(positionals[0], "应用名");
			return act(client, app, { type: "sendKeys", key: requireText(positionals[1], "组合键") });
		}
		case "fill": {
			const app = requireText(positionals[0], "应用名");
			const element = intFlag(flags, "element");
			if (element === undefined) throw new HelperError("badArguments", "fill 需要 --element N");
			const value = stringFlag(flags, "value");
			if (value === undefined) throw new HelperError("badArguments", "fill 需要 --value");
			return act(client, app, { type: "fillValue", elementNumber: element, value });
		}
		case "paste": {
			const app = requireText(positionals[0], "应用名");
			const text = requireText(positionals[1], "文字");
			return act(client, app, { type: "pasteText", text, format: stringFlag(flags, "format") });
		}
		case "scroll": {
			const app = requireText(positionals[0], "应用名");
			const direction = requireText(positionals[1], "方向 up|down|left|right");
			if (!["up", "down", "left", "right"].includes(direction)) {
				throw new HelperError("badArguments", "方向必须是 up、down、left 或 right");
			}
			return act(client, app, { type: "scrollView", ...targetFrom(flags), direction, pages: intFlag(flags, "pages") });
		}
		case "drag": {
			const app = requireText(positionals[0], "应用名");
			const from = pointFlag(flags, "from");
			const to = pointFlag(flags, "to");
			return act(client, app, {
				type: "dragItem",
				startX: from.x,
				startY: from.y,
				endX: to.x,
				endY: to.y,
			});
		}
		case "invoke": {
			const app = requireText(positionals[0], "应用名");
			const element = intFlag(flags, "element");
			if (element === undefined) throw new HelperError("badArguments", "invoke 需要 --element N");
			return act(client, app, {
				type: "invokeAction",
				elementNumber: element,
				name: requireText(stringFlag(flags, "name"), "--name"),
			});
		}
		case "run-command": {
			const app = requireText(positionals[0], "应用名");
			const path = parseCommandPath(requireText(positionals[1], "菜单路径"));
			return act(client, app, { type: "runCommand", path });
		}
		case "commands": {
			const app = requireText(positionals[0], "应用名");
			const reply = (await client.request("appCommands", { app })) as {
				commands?: Array<{ path?: unknown; shortcut?: unknown }>;
			};
			const query = stringFlag(flags, "query")?.toLowerCase();
			if (!query || !Array.isArray(reply?.commands)) return reply;
			return {
				...reply,
				commands: reply.commands.filter((c) => JSON.stringify(c).toLowerCase().includes(query)),
			};
		}
		case "wait": {
			const app = requireText(positionals[0], "应用名");
			const until = requireText(stringFlag(flags, "until"), "--until");
			const seconds = flags.timeout === undefined ? 10 : Number(stringFlag(flags, "timeout"));
			if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) {
				throw new HelperError("badArguments", "--timeout 必须在 0–60 秒之间");
			}
			const timeoutMs = Math.round(seconds * 1000);
			return client.request(
				"waitFor",
				compact({
					app,
					until,
					text: stringFlag(flags, "text"),
					elementNumber: intFlag(flags, "element"),
					timeoutMs,
				}),
				timeoutMs + 20_000,
			);
		}
		case "preview": {
			const mode = requireText(positionals[0], "on 或 off");
			if (mode !== "on" && mode !== "off") throw new HelperError("badArguments", "preview 只接受 on 或 off");
			return client.request("previewPanel", { show: mode === "on" });
		}
		case "finish":
			return client.request("finishTurn", {});
		default:
			throw new HelperError("badArguments", `未知命令：${command}（运行 help 查看用法）`);
	}
}

function pointFlag(flags: Flags, key: string): { x: number; y: number } {
	const raw = stringFlag(flags, key);
	const match = raw ? /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(raw.trim()) : null;
	if (!match) throw new HelperError("badArguments", `--${key} 需要 X,Y 形式的截图像素坐标`);
	return { x: Number(match[1]), y: Number(match[2]) };
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** act 请求：所有动作都走这里，超时不重试（可能已经执行过） */
function act(client: HelperClient, app: string, step: Record<string, unknown>): Promise<unknown> {
	return client.request("act", { app, step: compact(step) });
}

async function main(): Promise<void> {
	const [command = "help", ...rest] = process.argv.slice(2);
	if (command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return;
	}
	const { positionals, flags } = parseArgs(rest);
	const client = new HelperClient({
		socketPath: socketPath(),
		clientName: "oh-my-agent-web",
		session: buildSession(),
	});
	try {
		const result = await run(command, positionals, flags, client);
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	} catch (error) {
		const info =
			error instanceof HelperError
				? { name: error.errorName, message: error.message, retryable: error.retryable }
				: { name: "cliError", message: error instanceof Error ? error.message : String(error), retryable: false };
		process.stdout.write(`${JSON.stringify({ ok: false, error: info })}\n`);
		process.exitCode = 1;
	} finally {
		client.close();
	}
}

// 仅作为入口运行时才执行（被 import 做单元测试时不执行）
const isEntry = process.argv[1] !== undefined && /cli\.(c|m)?(j|t)s$/.test(process.argv[1]);
if (isEntry) void main();
