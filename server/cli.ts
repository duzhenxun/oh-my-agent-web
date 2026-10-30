#!/usr/bin/env node
/**
 * 命令行入口（ADR-0031）：`oh-my-agent-web` / 简写 **`aw`** / **`agent-web`** [命令] [选项]。
 * 三个 bin 指向同一个文件，完全等价（`agent-web` 给不想记缩写的人用）。
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
 *   -P, --password <pwd>  AGENT_WEB_PASSWORD   非本机访问时的登录密码（写进 <dataDir>/password，之后以那份为准）
 *                                              给了就存进数据目录，下次重启不必再给
 *       --allow-host <h>  AGENT_WEB_ALLOWED_HOSTS  给「发给本机」的跨源请求额外放行的域名（一般用不到）
 *       --data-dir <dir>  AGENT_WEB_DATA_DIR   默认 ~/.oh-my-agent-web
 *   -d, --detach          后台运行（脱离终端，日志进 daemon.log）
 *   -f, --foreground      前台运行（就是默认，留着给老脚本）
 *       --no-open         不要在浏览器里打开页面
 *
 * 默认行为：**前台起来 + 打开浏览器**（日志直接打在终端，Ctrl-C 退出）；`-d` 才丢到后台。
 * 后台模式只是「spawn 一个脱离终端的自己 + 等它写好 server.lock」：
 * 真正的事实源仍然是锁文件，所以 stop / restart 对前台、后台一视同仁。
 *
 * 没给的选项会从 `<dataDir>/password`、`<dataDir>/allowed-hosts` 兜底（见 cli-config.ts）：
 * 这样 `restart` 少带参数也不会把远程访问关掉。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyStoredOptions } from "./cli-config.js";
import { writePasswordFile } from "./http/password-store.js";
import { migrateLegacyDataDir } from "./util/data-dir.js";
import { DEFAULT_DATA_DIR_NAME } from "./util/env.js";
import { prunePtyPrebuilds } from "./util/prune-pty.js";
import { fetchHealth, showStatus, showVersion, upgrade } from "./cli-info.js";
import { checkForUpdate, describeUpdate } from "./update-check.js";
import { defaultIsAlive, describeHolder, readLock } from "./session/lock.js";

const USAGE = `用法: agent-web [命令] [选项]        （agent-web / aw / oh-my-agent-web 三个命令完全等价）

命令:
  start              启动（默认前台；已在跑就只把地址给你，不会再起一个）
  start -d           后台运行（脱离终端，日志进 daemon.log，终端立刻还给你）
  stop               停止正在跑的实例（读 dataDir/server.lock 里的 pid）
  restart            先停再起（默认仍前台；带 -d 则后台）
  status             看状态：pid / 端口 / 已运行多久 / 引擎 / 会话数 / 工作区
  version            看版本号（-v / --version 同义）
  upgrade            升级全局安装（npm i -g <包名>@latest；private 包会拒绝并提示怎么做）
  help               显示本帮助（-h / --help 同义）

选项（也可以用环境变量）:
  -p, --port <n>       监听端口            AGENT_WEB_PORT（默认 25257）
  -H, --host <addr>    监听地址            AGENT_WEB_HOST（默认 127.0.0.1）
  -P, --password <pwd> 访问密码            AGENT_WEB_PASSWORD（给了就存进数据目录；之后一律以数据目录那份为准）
      --allow-host <h> 跨源白名单（少见）    AGENT_WEB_ALLOWED_HOSTS（可多次 / 逗号分隔）
      --data-dir <dir> 数据目录            AGENT_WEB_DATA_DIR（默认 ~/.oh-my-agent-web）
  -d, --detach         后台运行（脱离终端；日志见 daemon.log）
  -f, --foreground     前台运行（就是默认，留着给老脚本）
      --no-open        不要在浏览器里打开页面

密码只有一个来源：<dataDir>/password（给了 -P / AGENT_WEB_PASSWORD 会先写进去，之后只读它）
（设一次就一直在，重启不必重复输入；也可以在本机页面的 设置 → 远程 里改）。
远程（局域网 IP / 域名 / 隧道）只要访问时带上密码就能进，**不用再配域名白名单**；
但密码必须**先在本机设好**（本机打开 设置 → 远程，或启动时 -P）—— 远程不能设第一个密码。

例：
  aw                                                    # 前台起 + 打开页面（Ctrl-C 退出）
  aw -d                                                 # 后台起，终端立刻还给你
  aw -H 0.0.0.0                                    # 局域网可访问（先在本机设好密码）
  aw -H 0.0.0.0 -P <密码>                          # 直接带密码起（远程用域名/ IP 访问都行）
  aw status && aw restart                               # 看完状态再重启
  aw stop                                               # 停掉（前台/后台都行）`;

type ParsedArgs = {
	command: "start" | "stop" | "restart" | "status" | "version" | "upgrade";
	env: Record<string, string>;
	help: boolean;
	/** 前台运行（默认）；`-d` 关掉它 */
	foreground: boolean;
	/** 起来后要不要打开浏览器（`--no-open` 关掉） */
	open: boolean;
	/** `-P` 显式给的密码（`null` = 没给）：只有它会改写 `<dataDir>/password` */
	password: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
	const env: Record<string, string> = {};
	let command: ParsedArgs["command"] = "start";
	let help = false;
	let foreground = true;
	let open = true;
	/** `-P` 显式给的密码：只有它会改写 `<dataDir>/password`（纯环境变量不写） */
	let password: string | null = null;

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
		else if (arg === "-d" || arg === "--detach" || arg === "--daemon") foreground = false;
		else if (arg === "-f" || arg === "--foreground" || arg === "--fg") foreground = true;
		else if (arg === "--no-open") open = false;
		else if (arg === "--open") open = true;
		else if (arg === "-p" || arg === "--port") env.AGENT_WEB_PORT = takeValue();
		else if (arg === "-H" || arg === "--host") env.AGENT_WEB_HOST = takeValue();
		else if (arg === "-P" || arg === "--password") {
			password = takeValue();
			env.AGENT_WEB_PASSWORD = password;
		} else if (arg === "--allow-host") {
			const value = takeValue();
			env.AGENT_WEB_ALLOWED_HOSTS = [env.AGENT_WEB_ALLOWED_HOSTS, value].filter(Boolean).join(",");
		} else if (arg === "--data-dir") env.AGENT_WEB_DATA_DIR = resolve(takeValue());
		else if (arg.startsWith("-")) throw new Error(`未知选项：${arg}`);
		else throw new Error(`未知命令：${arg}`);
	}
	return { command, env, help, foreground, open, password };
}

function dataDir(): string {
	const fromEnv = process.env.AGENT_WEB_DATA_DIR;
	return fromEnv && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), DEFAULT_DATA_DIR_NAME);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 等到进程消失或超时；返回是否已经退了 */
async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(100);
		if (!defaultIsAlive(pid)) return true;
	}
	return !defaultIsAlive(pid);
}

/**
 * 请服务自己收尾（flush 转录 → 收掉引擎子进程 → 还给锁）。
 *
 * 为什么要走 HTTP 而不是发信号：**Windows 上 `SIGTERM` 被映射成 TerminateProcess，
 * 没有任何进程内处理器会跑** —— 发信号就是在回合写到一半时硬断电。
 * 安全上不多开口子：这个端点挂在鉴权之后，而本机回环本来就直接放行。
 */
async function requestShutdown(host: string, port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://${host}:${port}/api/shutdown`, {
			method: "POST",
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

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

	// ① 优雅路径：请它自己收尾。Windows 上这是唯一可行的优雅方式。
	const asked = await requestShutdown(probeHostOf(), lock.port);
	if (asked && (await waitGone(lock.pid, 8000))) {
		console.log("已停止");
		return true;
	}

	// ② 兜底：动硬的
	console.log(asked ? "8 秒内没退出，强制结束" : "优雅停机没响应，强制结束");
	if (process.platform === "win32") {
		// 必须 /T：node 还拉着 cmd.exe → 引擎子进程，只杀父进程会留一堆孤儿
		try {
			spawnSync("taskkill", ["/pid", String(lock.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} catch {
			// 已经不在了就算了
		}
		return true;
	}
	try {
		process.kill(lock.pid, "SIGTERM");
	} catch {
		return false;
	}
	if (await waitGone(lock.pid, 3000)) {
		console.log("已停止");
		return true;
	}
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

/** 拼出「停止」的准确命令：沿用本次参数（去掉前后台/开页开关与命令词），密码一律打成 *** */
function stopHint(rawArgv: string[]): string {
	const rest: string[] = [];
	const IGNORED = new Set([
		"-d",
		"--detach",
		"--daemon",
		"-f",
		"--foreground",
		"--fg",
		"--open",
		"--no-open",
		"start",
		"restart",
	]);
	for (let i = 0; i < rawArgv.length; i += 1) {
		const arg = rawArgv[i] ?? "";
		if (IGNORED.has(arg)) continue;
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

/** 后台子进程要带上的开关（它自己不能再往后台上套娃，也不要再开一次浏览器） */
const CHILD_FLAGS = ["-f", "--no-open"];
/** 子进程要把这些去掉：前后台/开页开关 + 命令词（它只需要「起」，不需要再重启一次） */
const PROCESS_FLAGS = new Set([
	"-d",
	"--detach",
	"--daemon",
	"-f",
	"--foreground",
	"--fg",
	"--open",
	"--no-open",
	"start",
	"restart",
]);

/**
 * 打开系统浏览器。
 *
 * 什么时候**不**开：`--no-open`、没有终端（CI / 被别的程序拉起）、Linux 上没有图形会话。
 * 打不开也不报错 —— URL 已经打在终端里了，复制一下就能用。
 */
function openBrowser(url: string): void {
	if (!process.stdout.isTTY || process.env.CI) return;
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], { stdio: "ignore", detached: true }).unref();
		} else if (process.platform === "win32") {
			// `start` 的第一个参数是窗口标题，必须留一个空串，否则带引号的 URL 会被当成标题
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
		} else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
			spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
		}
	} catch {
		// 没装 xdg-open / 权限不够：忽略
	}
}

/** 前台模式：等服务真的在听，再开浏览器（起不来就不开，日志里已经有原因了） */
function openWhenReady(): void {
	const probeHost = probeHostOf();
	const deadline = Date.now() + 20_000;
	void (async () => {
		while (Date.now() < deadline) {
			const lock = await readLock(dataDir());
			if (lock && (await fetchHealth(probeHost, lock.port, 1000))) {
				openBrowser(`http://${probeHost}:${lock.port}`);
				return;
			}
			await sleep(200);
		}
	})();
}

async function startDetached(rawArgv: string[], open: boolean): Promise<void> {
	const script = fileURLToPath(import.meta.url);
	// 把自己再起一遍，但去掉前后台/开页开关 —— 子进程固定「前台 + 不开页」（开页是父进程的事）
	const args = [...rawArgv.filter((arg) => !PROCESS_FLAGS.has(arg)), ...CHILD_FLAGS];
	const log = daemonLogPath();
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	const child = spawn(process.execPath, [script, ...args], {
		detached: true, // 脱离当前终端：关掉终端不会把它一起收走
		stdio: ["ignore", fd, fd],
		// 子进程的 stdout 是 daemon.log：别让 quietConsole 把它的正常日志吞了（那是后台模式唯一的现场）
		env: { ...process.env, AGENT_WEB_FOREGROUND: "0" },
		cwd: process.cwd(),
		// Windows 上 detached 会连带开一个 console：不关掉就会闪一下黑框
		windowsHide: true,
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
			if (open) openBrowser(`http://${probeHost}:${lock.port}`);
			return;
		}
	}
	console.error(
		exited ? "后台启动失败（进程已退出），日志最后几行：" : "后台启动失败（20 秒内没写好 server.lock），日志最后几行：",
	);
	console.error(tailOf(log, 20));
	process.exitCode = 1;
}

/**
 * 起来之前先看锁（ADR-0007）：已经有一个在跑，就不起第二个。
 *
 * 为什么放在 CLI 而不是只靠 `index.ts` 里的 `acquireLock`：那边要先把会话索引、价格表
 * 都装完才走到拿锁那一步 —— 用户敲完 `aw` 干等几秒，最后看到一条 error；`-d` 更糟，
 * 父进程发现子进程退出，只能甩一段 daemon.log 出来。
 *
 * 三个命令名（`aw` / `agent-web` / `oh-my-agent-web`）本来就走同一份 cli.js，
 * 所以这一处检测对三者完全一致。
 *
 * @returns true = 已经有一个在跑，本次不再启动
 */
async function detectRunning(open: boolean): Promise<boolean> {
	const lock = await readLock(dataDir());
	// 无锁 / 锁里的 pid 已经不在（陈旧锁）：照常启动，接管交给 index.ts 的 acquireLock
	if (!lock || !defaultIsAlive(lock.pid)) return false;

	const probeHost = probeHostOf();
	const url = `http://${probeHost}:${lock.port}`;
	const stop = stopHint(process.argv.slice(2));
	if (await fetchHealth(probeHost, lock.port, 1500)) {
		console.log(`已经有一个在跑，不再起第二个：\n  ${describeHolder(lock)}\n  → 打开 ${url}\n  → 停止：${stop}`);
		if (open) openBrowser(url);
		return true;
	}

	// 锁在、pid 也在，但端口不响应：可能还在启动（装会话索引），也可能卡死了。
	// 两种情况都不该再起一个 —— 那样只会在拿锁/绑端口时撞得莫名其妙。
	console.error(`已经有一个在跑，但 ${url} 暂时没响应：\n  ${describeHolder(lock)}`);
	console.error(`  → 还在启动就等一下；卡住了就收掉它：${stop}`);
	process.exitCode = 1;
	return true;
}

/** 用户敲的是哪个名字（aw / agent-web / oh-my-agent-web）：启动提示里照拄，不硬写 aw */
function invokedName(): string {
	const base = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
	// 直接用 node 跑文件（开发、脚本、npx）时 argv[1] 是 cli.js / cli.ts，没有任何命令名可用
	if (base === "" || base === "cli.js" || base === "cli.ts") return "aw";
	// Windows 上 npm 的 bin 是 .cmd（aw.cmd）
	return base.replace(/\.(cmd|exe|ps1|bat)$/i, "");
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
	// 只有 `-P/--password` 算「显式改密码」：它会写进 `<dataDir>/password`，
	// 之后一律以那份文件为准（用户 2026-10-30：「都用 ~/.oh-my-agent-web/password，
	// 不需要走 AGENT_WEB_PASSWORD」）。纯环境变量不再改写文件 —— 否则又会出现
	// 「设置里改了、重启后却变回去」那种自相矛盾。
	const explicitPassword = (parsed.password ?? "").trim();
	// 命令行没给的：用数据目录里存的那份补上（远程密码忘了带 = 远程直接 403，踩过）
	await applyStoredOptions(process.env, dataDir());

	if (parsed.command === "status") {
		await showStatus({ dataDir: dataDir(), probeHost: probeHostOf() });
		const line = describeUpdate(await checkForUpdate({ dataDir: dataDir() }).catch(() => null));
		if (line) console.log(`  ${line}`);
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

	// start / restart：顺手裁掉 node-pty 里别的平台的预编译产物（幂等，裁干净之后就是空转）。
	// 这事以前放在 postinstall，但 npm 11.16+ 会把它当成「未批准的 install 脚本」逐个警告，
	// 用户得先 approve 才轮到我们省体积 —— 挪到运行时顺便做，装包时就没有任何脚本要审了。
	const pruned = prunePtyPrebuilds();
	if (pruned?.removed) {
		console.log(`[oh-my-agent-web] node-pty 已裁掉 ${pruned.removed} 个无关平台的预编译产物（保留 ${pruned.keep}）`);
	}

	// start / restart：先确认不是「已经在跑了」（三个命令名共用这一处检测）
	if (await detectRunning(parsed.open)) return;

	// 真的要起来了，才把「显式给的密码」落盘：已经在跑的时候不写，
	// 否则文件里的新密码和当前进程里的旧密码对不上，只会让人下次重启时奇怪。
	// 写进去之后，下次 `aw` 不带 -P 也仍然有密码（用户 2026-10-30 的要求）。
	if (explicitPassword !== "") {
		try {
			await writePasswordFile(join(dataDir(), "password"), explicitPassword);
		} catch (error) {
			// 存不下不该拦住启动：进程内存里仍然有密码，只是下次重启得再给一次
			console.error(
				`[oh-my-agent-web] 访问密码没能存进数据目录（${error instanceof Error ? error.message : String(error)}）：本次仍然生效，但重启后要重新给`,
			);
		}
	}

	// start / restart：默认**前台**跑（日志直接打在终端，Ctrl-C 退出），`-d` 才丢到后台
	if (!parsed.foreground) {
		// 后台启动：并发问一次，起来之后再打印（别让网络拖住启动）
		const update = checkForUpdate({ dataDir: dataDir() }).catch(() => null);
		await startDetached(process.argv.slice(2), parsed.open);
		const line = describeUpdate(await update);
		if (line) console.log(line);
		return;
	}
	if (parsed.open) openWhenReady();
	// 告诉服务层「终端在看着」：只留 warn / error，正常日志光进文件（见 index.ts 的 quietConsole）。
	// 必须看 isTTY：后台子进程也走这个分支，但它的 stdout 是 daemon.log —— 那里要保留全部日志。
	if (process.stdout.isTTY) process.env.AGENT_WEB_FOREGROUND = "1";
	// 升级提示由 index.ts 印在启动那屏里（`aw > log` 这种不是 TTY 的也照样印）。
	// 后台子进程（`AGENT_WEB_FOREGROUND=0`，见 startDetached）跳过：那一路的提示由父进程在
	// 终端上印，子进程再印一份就只会在 daemon.log 里重复一遍（还白查一次 registry）。
	if (process.env.AGENT_WEB_FOREGROUND !== "0") process.env.AGENT_WEB_UPDATE_NOTICE = "1";
	// 启动提示里的命令名（aw / agent-web / oh-my-agent-web）由实际敲的那个决定
	process.env.AGENT_WEB_CLI_NAME = invokedName();
	await import("./index.js");
	// 前台的「有新版本」提示由 index.ts 印在启动那屏（banner）下面：
	// 这里再印一次就会跑到 banner 上面去、还容易被启动日志淹没。
}

// 被当脚本执行时才 main（被 import 时什么都不做）
if (invokedDirectly()) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export { stopServer, USAGE };
