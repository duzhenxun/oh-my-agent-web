/**
 * 命令行入口（ADR-0031）：`agent-web [start|stop|restart] [选项]`。
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
 *       --data-dir <dir>  AGENT_WEB_DATA_DIR   默认 ~/.agent-web
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { defaultIsAlive, readLock } from "./session/lock.js";

const USAGE = `用法: agent-web [start|stop|restart] [选项]

  start              启动（默认）
  stop               停止正在跑的实例（读 dataDir/server.lock 里的 pid）
  restart            先停再起

选项（也可以用环境变量）:
  -p, --port <n>       监听端口            AGENT_WEB_PORT（默认 25257）
  -H, --host <addr>    监听地址            AGENT_WEB_HOST（默认 127.0.0.1）
  -P, --password <pwd> 访问密码            AGENT_WEB_PASSWORD
      --allow-host <h> 额外允许的域名      AGENT_WEB_ALLOWED_HOSTS（可多次 / 逗号分隔）
      --data-dir <dir> 数据目录            AGENT_WEB_DATA_DIR（默认 ~/.agent-web）
  -h, --help           显示本帮助`;

type ParsedArgs = { command: "start" | "stop" | "restart"; env: Record<string, string>; help: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
	const env: Record<string, string> = {};
	let command: ParsedArgs["command"] = "start";
	let help = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		const takeValue = () => {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("-")) throw new Error(`${arg} 缺少参数值`);
			i += 1;
			return value;
		};
		if (arg === "start" || arg === "stop" || arg === "restart") command = arg;
		else if (arg === "-h" || arg === "--help") help = true;
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
	return { command, env, help };
}

function dataDir(): string {
	const fromEnv = process.env.AGENT_WEB_DATA_DIR;
	return fromEnv && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), ".agent-web");
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

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		console.log(USAGE);
		return;
	}
	Object.assign(process.env, parsed.env);

	if (parsed.command === "stop") {
		await stopServer();
		return;
	}
	if (parsed.command === "restart") {
		await stopServer();
		// 等端口真正释放再起，否则会撞 EADDRINUSE
		await sleep(400);
	}

	// start / restart：直接在本进程里跑服务（不再 spawn 一次，日志与退出码都在同一条线上）
	await import("./index.js");
}

// 被当脚本执行时才 main（import 进来的纯函数可以单测）
if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export { stopServer, USAGE };
