#!/usr/bin/env node
/**
 * 命令行入口（ADR-0031）：`oh-my-agent-web` / 简写 **`omaw`** [命令] [选项]。
 *
 * 命令：start（默认）/ stop / restart / status / version / upgrade / help
 *
 * 为什么要有它：以前只能用 `npm start`，进程一多就「端口被占」，而停掉旧进程得自己
 * `lsof`/`kill`。这里把常用三件事收进一条命令，并且复用 `server.lock`（ADR-0007）
 * 里记的 pid —— 不去猜、不去扫端口。
 *
 * 选项（也可用同名环境变量，命令行优先）：
 *   -p, --port <n>        AGENT_WEB_PORT       默认 25257
 *   -H, --host <addr>     AGENT_WEB_HOST       默认 127.0.0.1
 *   -P, --password <pwd>  AGENT_WEB_PASSWORD   非本机访问时的登录密码
 *       --allow-host <h>  AGENT_WEB_ALLOWED_HOSTS  额外允许的域名（可重复）
 *       --data-dir <dir>  AGENT_WEB_DATA_DIR   默认 ~/.oh-my-agent-web
 *   -d, --detach          启动后转入后台（关掉终端也继续跑）
 *
 * 后台模式只是「spawn 一个脱离终端的自己 + 等它写好 server.lock」：
 * 真正的事实源仍然是锁文件，所以 stop / restart 对前台、后台一视同仁。
 *
 * 没给的选项会从 `<dataDir>/password`、`<dataDir>/allowed-hosts` 兜底（见 cli-config.ts）：
 * 这样 `restart` 少带参数也不会把远程访问关掉。
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyStoredOptions } from "./cli-config.js";
import { migrateLegacyDataDir } from "./util/data-dir.js";
import { DEFAULT_DATA_DIR_NAME } from "./util/env.js";
import { fetchHealth, showStatus, showVersion, upgrade } from "./cli-info.js";
import { defaultIsAlive, readLock } from "./session/lock.js";

const USAGE = `用法: omaw [命令] [选项]        （omaw 是 oh-my-agent-web 的简写，二者等价）

命令:
  start              启动（默认；前台运行，Ctrl-C 退出）
  start -d           启动并转入后台（关掉终端也继续跑，日志写到 <dataDir>/daemon.log）
  stop               停止正在跑的实例（读 dataDir/server.lock 里的 pid）
  restart            先停再起（带 -d 则后台起）
  status             看状态：pid / 端口 / 已运行多久 / 引擎 / 会话数 / 工作区
  version            看版本号（-v / --version 同义）
  upgrade            升级全局安装（npm i -g <包名>@latest；private 包会拒绝并提示怎么做）
  help               显示本帮助（-h / --help 同义）

选项（也可以用环境变量）:
  -p, --port <n>       监听端口            AGENT_WEB_PORT（默认 25257）
  -H, --host <addr>    监听地址            AGENT_WEB_HOST（默认 127.0.0.1）
  -P, --password <pwd> 访问密码            AGENT_WEB_PASSWORD
      --allow-host <h> 额外允许的域名      AGENT_WEB_ALLOWED_HOSTS（可多次 / 逗号分隔）
      --data-dir <dir> 数据目录            AGENT_WEB_DATA_DIR（默认 ~/.oh-my-agent-web）
  -d, --detach         启动后转入后台（日志写到 <dataDir>/daemon.log）

没给 --password / --allow-host 时，会读数据目录里的 password / allowed-hosts 兜底
（设一次就一直在，重启不必重复输入）。

例：
  omaw -d -H 0.0.0.0 -P 你的密码 --allow-host agent.example.com   # 后台起，供外网访问
  omaw status && omaw restart -d                                  # 看完状态再重启
  omaw stop                                                       # 停掉（前台/后台都行）`;

type ParsedArgs = {
	command: "start" | "stop" | "restart" | "status" | "version" | "upgrade";
	env: Record<string, string>;
	help: boolean;
	/** 启动后转入后台 */
	detach: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
	const env: Record<string, string> = {};
	let command: ParsedArgs["command"] = "start";
	let help = false;
	let detach = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		const takeValue = () => {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("-")) throw new Error(`${arg} 缺少参数值`);
			i += 1;
			return value;
		};
		if (arg === "start" || arg === "stop" || arg === "restart") command = arg;
		else if (arg === "status" || arg === "stat" || arg === "ps") command = "status";
		else if (arg === "version" || arg === "-v" || arg === "--version") command = "version";
		else if (arg === "upgrade" || arg === "up") command = "upgrade";
		else if (arg === "-h" || arg === "--help" || arg === "help") help = true;
		else if (arg === "-d" || arg === "--detach" || arg === "--daemon") detach = true;
		else if (arg === "-p" || arg === "--port") env.AGENT_WEB_PORT = takeValue();
		else if (arg === "-H" || arg === "--host") env.AGENT_WEB_HOST = takeValue();
		else if (arg === "-P" || arg === "--password") env.AGENT_WEB_PASSWORD = takeValue();
		else if (arg === "--allow-host") {
			const value = takeValue();
			env.AGENT_WEB_ALLOWED_HOSTS = [env.AGENT_WEB_ALLOWED_HOSTS, value].filter(Boolean).join(",");
		} else if (arg === "--data-dir") env.AGENT_WEB_DATA_DIR = resolve(takeValue());
		else if (arg.startsWith("-")) throw new Error(`未知选项：${arg}`);
		else throw new Error(`未知命令：${arg}`);
	}
	return { command, env, help, detach };
}

function dataDir(): string {
	const fromEnv = process.env.AGENT_WEB_DATA_DIR;
	return fromEnv && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), DEFAULT_DATA_DIR_NAME);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 停掉锁文件里记录的进程；返回是否真的停了一个 */
async function stopServer(): Promise<boolean> {
	const lock = await readLock(dataDir());
	if (!lock) {
		console.log("没有找到运行中的实例（没有 server.lock）");
		return false;
	}
	if (!defaultIsAlive(lock.pid)) {
		console.log(`锁里的进程 ${lock.pid} 已经不在（陈旧锁，下次启动会自动接管）`);
		return false;
	}
	console.log(`正在停止 pid ${lock.pid}（端口 ${lock.port}）…`);
	try {
		process.kill(lock.pid, "SIGTERM");
	} catch (error) {
		console.error(`发送 SIGTERM 失败：${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
	// 给它 8 秒优雅退出（回合可能正在落盘转录）
	for (let i = 0; i < 80; i += 1) {
		await sleep(100);
		if (!defaultIsAlive(lock.pid)) {
			console.log("已停止");
			return true;
		}
	}
	console.log("8 秒内没退出，强制结束");
	try {
		process.kill(lock.pid, "SIGKILL");
	} catch {
		// 已经不在了就算了
	}
	return true;
}

/** 后台模式的日志文件（前台日志另有轮转文件，这个只兜住 stdout/stderr） */
function daemonLogPath(): string {
	return join(dataDir(), "daemon.log");
}

/** 读文件末尾若干行（后台启动失败时把原因打给用户看） */
function tailOf(file: string, lines: number): string {
	try {
		const text = readFileSync(file, "utf8").trimEnd().split("\n");
		return text.slice(-lines).join("\n");
	} catch {
		return "(没有日志)";
	}
}

/**
 * 后台启动：spawn 一个**脱离终端**的自己，然后等它把 `server.lock` 写出来。
 *
 * 为什么不是 `child.unref()` 就完事：用户需要知道「到底起没起来 / 端口是多少 /
 * 没起来是为什么」，所以这里等锁出现才返回；失败时把 daemon.log 的尾巴打出来。
 * 锁仍然是唯一事实源 —— 所以 stop / restart 对前台、后台一视同仁。
 */
/** 探活用：0.0.0.0 / :: 这类通配地址要换成能真正连上的本机地址 */
function probeHostOf(): string {
	const host = process.env.AGENT_WEB_HOST ?? "127.0.0.1";
	return host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
}

/** 探活：等服务真的开始接请求（拿到锁 ≠ 端口已经在听，中间还要装载会话索引） */
async function waitForHttp(host: string, port: number, deadline: number): Promise<boolean> {
	while (Date.now() < deadline) {
		if (await fetchHealth(host, port, 1000)) return true;
		await sleep(200);
	}
	return false;
}

/** 拼出「停止」的准确命令：沿用本次参数（去掉 -d 与命令词），密码一律打成 *** */
function stopHint(rawArgv: string[]): string {
	const rest: string[] = [];
	for (let i = 0; i < rawArgv.length; i += 1) {
		const arg = rawArgv[i] ?? "";
		if (["-d", "--detach", "--daemon", "start", "restart"].includes(arg)) continue;
		// 行命令会留在终端滚动区和 shell 历史里，密码不能跟着回显
		if (arg === "-P" || arg === "--password") {
			rest.push(arg, "***");
			i += 1;
			continue;
		}
		rest.push(arg);
	}
	const entry = process.argv[1] ?? "";
	const base = entry.split("/").pop() ?? "oh-my-agent-web";
	const prefix = base === "cli.js" ? `node ${entry}` : base;
	return [prefix, "stop", ...rest].join(" ");
}

async function startDetached(rawArgv: string[]): Promise<void> {
	const script = fileURLToPath(import.meta.url);
	// 把自己再起一遍，但去掉 -d（否则子进程会继续往后台上套娃）
	const args = rawArgv.filter((arg) => arg !== "-d" && arg !== "--detach" && arg !== "--daemon");
	const log = daemonLogPath();
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	const child = spawn(process.execPath, [script, ...args], {
		detached: true, // 脱离当前终端：关掉终端不会把它一起收走
		stdio: ["ignore", fd, fd],
		env: process.env,
		cwd: process.cwd(),
	});
	child.unref();
	closeSync(fd);

	let exited = false;
	child.once("exit", () => {
		exited = true;
	});

	const probeHost = probeHostOf();
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await sleep(150);
		if (exited) break;
		const lock = await readLock(dataDir());
		if (lock && lock.pid === child.pid && defaultIsAlive(lock.pid)) {
			// 拿到锁之后还要等它真的开始接请求（中间要装载 pi 会话索引）
			if (!(await waitForHttp(probeHost, lock.port, deadline))) break;
			console.log(`已在后台启动：pid ${child.pid}，端口 ${lock.port}`);
			console.log(`  → 打开 http://${probeHost}:${lock.port}`);
			console.log(`  → 日志 ${log}`);
			console.log(`  → 停止：${stopHint(rawArgv)}`);
			return;
		}
	}
	console.error(
		exited ? "后台启动失败（进程已退出），日志最后几行：" : "后台启动失败（20 秒内没写好 server.lock），日志最后几行：",
	);
	console.error(tailOf(log, 20));
	process.exitCode = 1;
}

/** 是否被当脚本执行（npx / 全局安装时 argv[1] 是 bin 软链，必须比 realpath） */
function invokedDirectly(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		console.log(USAGE);
		return;
	}
	Object.assign(process.env, parsed.env);
	// 旧目录（~/.agent-web）→ 新目录（~/.oh-my-agent-web）：搬的是密码/订阅/设置/日志/锁
	migrateLegacyDataDir({ dataDir: dataDir(), log: (line) => console.log(line) });
	// 命令行没给的：用数据目录里存的那份补上（远程密码忘了带 = 远程直接 403，踩过）
	await applyStoredOptions(process.env, dataDir());

	if (parsed.command === "status") {
		await showStatus({ dataDir: dataDir(), probeHost: probeHostOf() });
		return;
	}
	if (parsed.command === "version") {
		showVersion();
		return;
	}
	if (parsed.command === "upgrade") {
		process.exitCode = await upgrade();
		return;
	}
	if (parsed.command === "stop") {
		await stopServer();
		return;
	}
	if (parsed.command === "restart") {
		await stopServer();
		// 等端口真正释放再起，否则会撞 EADDRINUSE
		await sleep(400);
	}

	// start / restart：默认**在前台**跑（日志与退出码都在同一条线上）
	if (parsed.detach) {
		await startDetached(process.argv.slice(2));
		return;
	}
	await import("./index.js");
}

// 被当脚本执行时才 main（被 import 时什么都不做）
if (invokedDirectly()) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export { stopServer, USAGE };
