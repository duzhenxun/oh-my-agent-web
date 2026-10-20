/**
 * 开发态一条命令起两个进程（ADR-0007：`npm run dev`）。
 *
 * 刻意不引 concurrently：这层只需要「起两个子进程 + 转发 Ctrl-C + 任一退出就收摊」，
 * 二十行以内能写完，比多一个依赖划算（何况本项目有依赖预算，ADR-0008）。
 *
 * 端口（ADR-0007）：**对外只有一个 25257**（开发期由 Vite 监听，生产期由后端监听）。
 * 开发态后端躲到内部端口 25258，只给 Vite 反代用 —— 这样开发和生产记的是同一个地址，
 * 也不用再解释「开发是 5174、生产是 25257」这种差异。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CHILDREN = [
	{
		name: "server",
		command: process.execPath,
		args: ["--import", "tsx", "--watch", join(REPO_ROOT, "server/index.ts")],
		env: { AGENT_WEB_PORT: process.env.AGENT_WEB_BACKEND_PORT ?? "25258" },
	},
	{
		name: "web",
		command: "npm",
		args: ["exec", "--", "vite", "--config", join(REPO_ROOT, "web/vite.config.ts")],
		env: {},
	},
];

const running = new Map();
let shuttingDown = false;

function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of running.values()) child.kill("SIGTERM");
	setTimeout(() => process.exit(code), 200);
}

for (const spec of CHILDREN) {
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
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] 打开 http://127.0.0.1:25257 （后端在内部 :25258，Ctrl-C 停止两者）");
