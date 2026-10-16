/**
 * 冒烟：读出 pi 已有会话（ADR-0021 §1）。
 *
 * 自包含：临时 PI_AGENT_DIR（造一个假的 pi 会话目录）+ 临时数据目录 + 专用端口。
 * 断言的是「侧栏要显示什么」这条链路：扫 header → 分组 → 进快照 → 前端能拿到。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 8903;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "agent-web-pi-smoke-data-"));
const piAgentDir = mkdtempSync(join(tmpdir(), "agent-web-pi-smoke-agent-"));

const failures = [];
const check = (ok, label, detail = "") => {
	if (ok) console.log(`  ✓ ${label}`);
	else {
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
		failures.push(label);
	}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个与真实布局一致的 pi 会话：目录名是编码过的 cwd，文件首行是 header */
function seedPiSession() {
	const projectDir = join(piAgentDir, "sessions", "--tmp-demo-project--");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, "2026-10-16T00-00-00-000Z_demo.jsonl"),
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "demo",
				timestamp: "2026-10-16T00:00:00.000Z",
				cwd: "/tmp/demo-project",
			}),
			JSON.stringify({ type: "model_change", provider: "demo", modelId: "demo-model" }),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "这是 pi 里已有的会话" }] },
			}),
		].join("\n")}\n`,
		"utf8",
	);
}

function startServer() {
	return spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server/index.ts")], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			AGENT_WEB_PORT: String(PORT),
			AGENT_WEB_DATA_DIR: dataDir,
			AGENT_WEB_CWD: REPO_ROOT,
			AGENT_WEB_ENGINE: "fake",
			AGENT_WEB_LOG: "warn",
			PI_AGENT_DIR: piAgentDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

// 先造好假会话，再启动服务（启动时会扫一次；之后的刷新有 10s 下限）
seedPiSession();
const server = startServer();
let socket = null;

try {
	console.log(`\n冒烟：pi 已有会话（端口 ${PORT}，PI_AGENT_DIR=${piAgentDir}）\n`);
	for (let index = 0; index < 80; index += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (response.ok) break;
		} catch {
			// 还没起来
		}
		await sleep(150);
	}
	socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
	const frames = [];
	socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	await sleep(300);

	// 刷新一次（get_state 会带 10s 下限触发扫描）
	socket.send(JSON.stringify({ id: "p1", type: "get_state" }));
	const deadline = Date.now() + 15_000;
	let snapshot = null;
	while (Date.now() < deadline) {
		snapshot = frames
			.filter((frame) => frame.type === "event" && frame.event === "snapshot")
			.map((frame) => frame.snapshot)
			.at(-1);
		if ((snapshot?.piProjects.length ?? 0) > 0) break;
		await sleep(200);
	}

	const project = snapshot?.piProjects[0];
	check(project?.name === "demo-project", "项目名取 cwd 最后一段", String(project?.name));
	check(project?.cwd === "/tmp/demo-project", "项目 cwd 来自会话 header", String(project?.cwd));
	check(
		project?.sessions[0]?.title === "这是 pi 里已有的会话",
		"会话标题取首条 user 消息",
		String(project?.sessions[0]?.title),
	);
	check(project?.sessions[0]?.model === "demo/demo-model", "读到该会话使用的模型", String(project?.sessions[0]?.model));
	check(typeof project?.sessions[0]?.updatedAt === "number", "会话带最后活动时间");

	// 缓存文件应落盘（否则每次刷新都要重读 247 个文件）
	await sleep(300);
	const { existsSync } = await import("node:fs");
	check(existsSync(join(dataDir, "pi-sessions-cache.json")), "扫描结果已缓存到数据目录");
} catch (error) {
	console.log(`  ✗ 冒烟执行失败：${error instanceof Error ? error.message : String(error)}`);
	failures.push("执行失败");
} finally {
	socket?.close();
	server.kill("SIGTERM");
	await sleep(200);
	if (server.exitCode === null) server.kill("SIGKILL");
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(piAgentDir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.error(`❌ pi-sessions-smoke 失败：${failures.length} 项\n`);
	process.exit(1);
}
console.log("✅ pi-sessions-smoke 通过\n");
