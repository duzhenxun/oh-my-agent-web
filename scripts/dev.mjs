/**
 * 开发态一条命令起两个进程（ADR-0007：`npm run dev`）。
 *
 * 刻意不引 concurrently：这层只需要「起两个子进程 + 转发 Ctrl-C + 任一退出就收摊」，
 * 二十行以内能写完，比多一个依赖划算（何况本项目有依赖预算，ADR-0008）。
 *
 * 端口（ADR-0007）：**对外只有一个 25257**（开发期由 Vite 监听，生产期由后端监听）。
 * 开发态后端躲到内部端口 25258，只给 Vite 反代用 —— 这样开发和生产记的是同一个地址，
 * 也不用再解释「开发是 5174、生产是 25257」这种差异。
 *
 * 顺序（别改回去）：**先起后端、等它能答话，再起 Vite**。
 * 反过来的话 Vite 206ms 就 ready，而后端要先扫一遍 pi 的历史会话（几百条要好几秒），
 * 浏览器这时已经在打 `/api/events` 和 `/api/health` 了 —— 满屏
 * `http proxy error: connect ECONNREFUSED 127.0.0.1:25258`，看着像接口炸了，
 * 其实只是抢跑。代价是前端晚几秒出现，换来一份干净的日志。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SERVER_PORT = process.env.AGENT_WEB_BACKEND_PORT ?? "25258";
const WEB_PORT = process.env.AGENT_WEB_DEV_PORT ?? "25257";

const SERVER = {
	name: "server",
	command: process.execPath,
	args: ["--import", "tsx", "--watch", join(REPO_ROOT, "server/index.ts")],
	env: {
		AGENT_WEB_PORT: SERVER_PORT,
		// 开发态后端永远只听回环：对外由 Vite 承担（它会把真实来源写进 X-Forwarded-For）
		AGENT_WEB_HOST: "127.0.0.1",
		// 让后端的 Origin/Host 白名单认这个对外端口（否则 WS 握手会被判为跨站）
		AGENT_WEB_DEV_PORT: WEB_PORT,
	},
};

const WEB = {
	name: "web",
	command: "npm",
	// 额外参数透传给 vite（例如 `npm run dev -- --host 0.0.0.0` 让手机也能访问）
	args: ["exec", "--", "vite", "--config", join(REPO_ROOT, "web/vite.config.ts"), ...process.argv.slice(2)],
	env: {},
};

const running = new Map();
let shuttingDown = false;

function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of running.values()) child.kill("SIGTERM");
	setTimeout(() => process.exit(code), 200);
}

function start(spec) {
	const child = spawn(spec.command, spec.args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: { ...process.env, ...spec.env },
	});
	running.set(spec.name, child);
	child.on("exit", (code) => {
		console.error(`\n[dev] ${spec.name} 退出（code=${code ?? 0}），一起收摊`);
		shutdown(code ?? 0);
	});
	child.on("error", (error) => {
		console.error(`[dev] ${spec.name} 起不来：${error.message}`);
		shutdown(1);
	});
	return child;
}

/**
 * 等后端真的 listen（`/api/health` 能答话）。
 *
 * 不看端口有没有开、也不 sleep 一个固定值：后端自己会先把锁、会话索引、provider 列表
 * 都准备好才 listen，`health` 回 200 就是「真的能用了」的唯一信号。
 */
async function waitForBackend(child, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	const startedAt = Date.now();
	let hinted = false;
	while (Date.now() < deadline) {
		if (shuttingDown || child.exitCode !== null || child.signalCode !== null) return false;
		// 免密等下去像卡住了：超过 2s 说一句在等什么（首次启动要扫一遍 pi 历史会话）
		if (!hinted && Date.now() - startedAt > 2000) {
			hinted = true;
			console.log(`[dev] 等后端 :${SERVER_PORT} 就绪（首次启动要扫一遍 pi 历史会话）…`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) return true;
		} catch {
			// 还没 listen（ECONNREFUSED）：等下一轮
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const server = start(SERVER);
const waitedFrom = Date.now();
if (!(await waitForBackend(server))) {
	if (!shuttingDown) {
		console.error(`[dev] 后端 :${SERVER_PORT} 一直没就绪（120s），不起了 —— 看上面后端自己的报错`);
		shutdown(1);
	}
} else {
	console.log(
		`[dev] 后端就绪（${((Date.now() - waitedFrom) / 1000).toFixed(1)}s），接着起 Vite\n` +
			`[dev] 打开 http://127.0.0.1:${WEB_PORT} （后端在内部 :${SERVER_PORT}，Ctrl-C 停止两者）`,
	);
	start(WEB);
}
