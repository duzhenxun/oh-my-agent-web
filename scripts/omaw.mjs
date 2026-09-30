#!/usr/bin/env node
/**
 * `npm run omaw` — 仓库内的一条总入口，行为取决于有没有参数：
 *
 *   npm run omaw                     起本地开发栈（源码直跑，2 个进程）
 *                                   = `npm run dev`：单进程、单端口 :25257，Vite 在进程内当中间件
 *   npm run omaw -- ps               转发给 CLI：进程 / 端口巡检
 *   npm run omaw -- stop             转发给 CLI：停掉监听 UI 端口的服务
 *   npm run omaw -- restart          转发给 CLI：停掉后重新起（前台）
 *   npm run omaw -- ws -p 25268      转发给 CLI：用 WS 客户端临时接入指定地址的 app-server
 *   npm run omaw -- --port 3000      转发给 CLI：直接起后端（源码直跑，不做 Vite）
 *   npm run omaw -- --help           CLI 帮助
 *
 * ⚠️ 参数必须写在 `--` 之后。
 *
 * npm（≥7）会先把 `-p` / `--port` / `--url` 这类 flag 当成*自己的*配置吃掉，
 * 剩下的位置参数才给脚本。实测 npm 11：
 *
 *   npm run omaw ws -p 25268   →  收到 ["ws", "25268"]   （-p 丢失，25268 被当成聊天消息）
 *   npm run omaw -- ws -p 25268 →  收到 ["ws", "-p", "25268"] ✅
 *
 * 这是 npm 的行为，脚本侧无法挽回（`npm_config_argv` 在 npm 7 已被移除），
 * 所以这里不去猜、也不做兜底，只负责老老实实转发。
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliEntry = join(repoRoot, "bin", "oh-my-agent-web.mjs");

const args = process.argv.slice(2);
const isWindows = process.platform === "win32";
const npmBin = isWindows ? "npm.cmd" : "npm";

/** 无参数 → 复用 `npm run dev`，避免把 dev 的命令行在这里抄一遍。 */
function childFor() {
	if (args.length === 0) {
		// 端口与 dev 保持一致：OMAW_PORT 未设时默认 25257。
		const port = Number(process.env.OMAW_PORT) || 25257;
		const host = process.env.OMAW_HOST ?? "127.0.0.1";
		return {
			command: npmBin,
			argv: ["run", "dev"],
			note: `dev stack → http://${host}:${port}  (源码模式，Vite 在进程内，无需 build)`,
		};
	}
	return { command: process.execPath, argv: [cliEntry, ...args], note: null };
}

const { command, argv, note } = childFor();
if (note) console.error(`[omaw] ${note}`);

const child = spawn(command, argv, {
	cwd: repoRoot,
	stdio: "inherit",
	// Windows 上 npm.cmd 需要 shell 才能被 spawn。
	shell: isWindows,
});

child.on("error", (err) => {
	console.error(`[omaw] failed to start: ${err.message}`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	// Ctrl-C 会同时发给整个前台进程组，这里只需要把退出状态如实传出去。
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
