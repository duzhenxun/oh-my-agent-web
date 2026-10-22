/**
 * `omaw` 的「查询类命令」：status / version / upgrade。
 *
 * 为什么单独成文件：cli.ts 已经要管参数解析、前后台切换、停止/重启，
 * 再加状态查询就过 400 行护栏了（ADR-0010：一个文件只干一件事）。
 * 这里只读锁文件、读 package.json、探一次 /api/health —— 不改任何状态。
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { defaultIsAlive, readLock } from "./session/lock.js";
import { packageMeta } from "./util/version.js";

type Health = {
	ok: boolean;
	protocolVersion: number;
	/** 跑着的这个进程的版本（= 它启动时的 package.json） */
	version?: string;
	workspace: string;
	engine: string;
	sessions: number;
	conversations: number;
};

/** 探活：拿服务端自报的引擎 / 会话数 / 工作区；连不上就 null */
export async function fetchHealth(host: string, port: number, timeoutMs = 1500): Promise<Health | null> {
	try {
		const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}/api/health`;
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok ? ((await response.json()) as Health) : null;
	} catch {
		return null;
	}
}

/** 「已运行 2 天 3 小时」这种给人看的时间 */
function formatUptime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (days > 0) return `${days} 天 ${hours} 小时`;
	if (hours > 0) return `${hours} 小时 ${minutes} 分`;
	if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
	return `${total} 秒`;
}

/** `omaw status`：进程状态 + 服务端自报的事实（引擎 / 会话数 / 工作区） */
export async function showStatus(options: { dataDir: string; probeHost: string }): Promise<void> {
	const { dataDir, probeHost } = options;
	const lock = await readLock(dataDir);
	console.log(`oh-my-agent-web v${packageMeta().version}  ·  数据目录 ${dataDir}`);

	if (!lock) {
		console.log("状态：未运行（没有 server.lock）");
		console.log("  启动：omaw -d");
		return;
	}
	if (!defaultIsAlive(lock.pid)) {
		console.log(`状态：未运行（陈旧锁：pid ${lock.pid} 已不在，下次 start 会自动接管）`);
		return;
	}

	const health = await fetchHealth(probeHost, lock.port);
	const onDisk = packageMeta().version;
	console.log(`状态：运行中（pid ${lock.pid}，已运行 ${formatUptime(Date.now() - lock.startedAt)}）`);
	console.log(`  地址 http://${probeHost}:${lock.port}`);
	if (health) {
		const running = health.version ?? "unknown";
		console.log(
			`  版本 v${running}（磁盘上是 v${onDisk}${running === onDisk ? "" : "，重启后生效：omaw restart -d"}）`,
		);
		console.log(
			`  引擎 ${health.engine} · 协议 v${health.protocolVersion} · 会话 ${health.sessions} · 对话 ${health.conversations}`,
		);
		console.log(`  工作区 ${health.workspace}`);
	} else {
		console.log("  ⚠ 进程在，但 /api/health 没通（可能还在启动，或端口没监听成功）");
	}
}

/** `omaw version` */
export function showVersion(): void {
	console.log(
		`oh-my-agent-web v${packageMeta().version}（node ${process.version} · ${process.platform}/${process.arch}）`,
	);
}

/**
 * `omaw upgrade`：升级**全局安装**的这个包。
 *
 * 三条底线：
 *   1. 只跑 `npm i -g <包名>@latest`，不做别的（不替你重启，重启会打断正在跑的回合）；
 *   2. `private: true` 的包**拒绝升级** —— 它根本没发布到 npm，照名字去装只会装到
 *      别人的同名包（npm 上 `oh-my-agent-web` 确实已被别人占用，踩过一次）；
 *   3. 输出原样透传，成功/失败都给出下一步该做什么。
 */
export async function upgrade(): Promise<number> {
	const meta = packageMeta();
	if (meta.private) {
		console.error(`这个包是 private（${meta.name}@${meta.version}），没有发布到 npm，无法从 npm 升级。`);
		console.error("  · 本地 / git 安装：回到源码目录重新 `npm i -g .`，然后 `omaw restart -d`");
		console.error("  · 想用 npm 升级：先把 package.json 的 name 改成自己 scope 下的名字（如 @you/omaw）并发布");
		return 1;
	}
	console.log(`当前 v${meta.version}，正在安装 npm 上的最新版 ${meta.name} …`);
	const code = await new Promise<number>((resolve) => {
		const child = spawn("npm", ["install", "-g", `${meta.name}@latest`], { stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`调用 npm 失败：${error.message}`);
			resolve(1);
		});
		child.on("exit", (exitCode) => resolve(exitCode ?? 1));
	});
	if (code !== 0) {
		console.error("升级失败（网络 / 权限 / 包名不存在都可能）。");
		return code;
	}
	console.log(`已升级到 v${packageMeta().version}（新进程才用新版：omaw restart -d）`);
	return 0;
}
