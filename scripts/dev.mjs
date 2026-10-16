/**
 * 开发态一条命令起两个进程（ADR-0007：`npm run dev`）。
 *
 * 刻意不引 concurrently：这层只需要「起两个子进程 + 转发 Ctrl-C + 任一退出就收摊」，
 * 二十行以内能写完，比多一个依赖划算（何况本项目有依赖预算，ADR-0008）。
 *
 * 端口（ADR-0007）：后端 8791、前端 5174 —— 全部避开参考实现的 8787/8788/5173。
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
		env: { AGENT_WEB_PORT: process.env.AGENT_WEB_PORT ?? "8791" },
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

console.log("[dev] 后端 :8791 · 前端 :5174（Ctrl-C 停止两者）");
