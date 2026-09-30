#!/usr/bin/env node
/**
 * npm run stop / npm run restart helper for the local oh-my-agent-web service.
 * It only targets a oh-my-agent-web process listening on OMAW_PORT.
 */
import { execFileSync, spawn } from "node:child_process";

const port = Number(process.env.OMAW_PORT || 25257);
const command = process.argv[2] || "stop";
const extraArgs = process.argv.slice(3);

function commandForPid(pid) {
	if (process.platform === "win32") {
		try {
			return execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	}
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

function listeningPids() {
	if (process.platform === "win32") {
		try {
			const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
			const pids = new Set();
			for (const line of output.split(/\r?\n/)) {
				if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
				const match = /\s+(\d+)\s*$/.exec(line);
				if (match) pids.add(Number(match[1]));
			}
			return [...pids];
		} catch {
			return [];
		}
	}
	try {
		const output = execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return [...new Set(output.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))];
	} catch {
		return [];
	}
}

/**
 * Is this pid one of ours?
 *
 * Matched against the **command line**, which differs by how the server was
 * started:
 *   - global install:  `…/bin/oh-my-agent-web.mjs` (or `…/bin/omaw` via the alias)
 *   - repo, dev:       `tsx watch server/index.ts` → the listener child runs
 *                      `node --require …/tsx … server/index.ts`
 *   - repo, built:     `node …/dist/server/index.js`
 *
 * The checkout folder name is deliberately NOT used: it can be anything, and
 * matching it only ever worked by accident (when the folder happened to be named
 * after the package).
 */
function isProjectProcess(pid) {
	const cmd = commandForPid(pid);
	if (/oh-my-agent-web|bin[\\/](?:oh-my-agent-web|omaw)/.test(cmd)) return true;
	// Dev / built entry point, however the runner was invoked. The path is
	// relative in the child's argv (`… tsx/dist/loader.mjs server/index.ts`), so
	// match on a word boundary rather than a preceding slash.
	return /\bserver[\\/]index\.(?:ts|js)\b/.test(cmd) && /\b(?:node|tsx)\b/.test(cmd);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stop() {
	const pids = listeningPids();
	if (pids.length === 0) {
		console.log(`oh-my-agent-web 未运行（端口 ${port}）。`);
		return true;
	}

	const owned = pids.filter(isProjectProcess);
	const foreign = pids.filter((pid) => !owned.includes(pid));
	if (foreign.length > 0) {
		console.error(`端口 ${port} 被其他进程占用，未执行停止：${foreign.join(", ")}`);
		return false;
	}
	if (owned.length === 0) {
		console.error(`端口 ${port} 被占用，但不是 oh-my-agent-web 进程，未执行停止。`);
		return false;
	}

	for (const pid of owned) {
		console.log(`正在停止 oh-my-agent-web (pid ${pid})…`);
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	}

	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline && owned.some(isAlive)) await sleep(200);
	const stuck = owned.filter(isAlive);
	for (const pid of stuck) {
		console.warn(`pid ${pid} 未退出，发送 SIGKILL…`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	console.log("oh-my-agent-web 已停止。");
	return true;
}

if (command === "stop") {
	process.exitCode = (await stop()) ? 0 : 1;
} else if (command === "restart") {
	if (!(await stop())) process.exit(1);
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const args = extraArgs.length > 0 ? ["start", "--", ...extraArgs] : ["start"];
	console.log("正在重新启动 oh-my-agent-web…");
	const child = spawn(npm, args, { stdio: "inherit", env: process.env });
	child.on("error", (error) => {
		console.error(`启动失败：${error.message}`);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		process.exitCode = code ?? (signal ? 1 : 0);
	});
} else {
	console.error(`未知命令：${command}。可用命令：stop、restart`);
	process.exitCode = 2;
}
