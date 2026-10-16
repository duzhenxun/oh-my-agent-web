/**
 * M3 的真实链路验收（手工跑，不进 CI）：真引擎 + 真审批 + 真文件改动。
 *
 * 用临时工作区与临时数据目录，绝不动你的真实项目与 ~/.agent-web。
 * 提示词刻意很小（一次往返 + 一次写文件 + 一次跑命令）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 8794;
const workspace = mkdtempSync(join(tmpdir(), "agent-web-live-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "agent-web-live-data-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
	cwd: process.cwd(),
	env: {
		...process.env,
		AGENT_WEB_PORT: String(PORT),
		AGENT_WEB_DATA_DIR: dataDir,
		AGENT_WEB_CWD: workspace,
		AGENT_WEB_ENGINE: "pi",
		AGENT_WEB_LOG: "info",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (c) => process.stdout.write(`[server] ${c}`));
server.stderr.on("data", (c) => process.stdout.write(`[server:err] ${c}`));

const prompt =
	"在 workspace 根目录创建文件 hello.txt，内容写 hi（用 write 工具）。" +
	"然后用 bash 跑 `cat hello.txt` 确认内容。只做这两件事，不要做别的，最后用一句话说明结果。";

try {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) break;
		} catch {}
		await sleep(150);
	}
	console.log(`\n工作区：${workspace}\n数据目录：${dataDir}\n`);

	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
	const frames = [];
	let approvals = 0;
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		frames.push(frame);
		if (frame.type === "event" && frame.event === "snapshot" && frame.snapshot.pendingApproval) {
			const approval = frame.snapshot.pendingApproval;
			approvals += 1;
			console.log(
				`\n>>> 审批请求 #${approvals}：${approval.toolName} | ${approval.scopeHint} | ${approval.argsSummary}`,
			);
			console.log(`    理由：${approval.riskNote}`);
			socket.send(
				JSON.stringify({
					id: `live-approve-${approvals}`,
					type: "approve",
					payload: { requestId: approval.requestId, decision: "always" },
				}),
			);
		}
	});
	await new Promise((res, rej) => {
		socket.on("open", res);
		socket.on("error", rej);
	});
	socket.send(JSON.stringify({ id: "live-1", type: "send_message", payload: { text: prompt } }));

	const deadline = Date.now() + 180_000;
	let lastStatus = "";
	while (Date.now() < deadline) {
		const snapshots = frames.filter((f) => f.type === "event" && f.event === "snapshot").map((f) => f.snapshot);
		const snapshot = snapshots[snapshots.length - 1];
		if (snapshot) {
			if (snapshot.running.status !== lastStatus) {
				lastStatus = snapshot.running.status;
				console.log(
					`[状态] ${lastStatus}${snapshot.running.activeTool ? ` · ${snapshot.running.activeTool.name}` : ""}`,
				);
			}
			if (snapshot.running.status === "idle" && snapshot.active.messages.length >= 2) break;
		}
		await sleep(250);
	}

	const snapshots = frames.filter((f) => f.type === "event" && f.event === "snapshot").map((f) => f.snapshot);
	const final = snapshots[snapshots.length - 1];
	const blocks = (final?.active.messages ?? []).flatMap((m) => m.blocks);
	const deltas = frames.filter((f) => f.type === "event" && f.event === "message_delta").length;

	console.log("\n===== 结果 =====");
	console.log(`会话消息数：${final?.active.messages.length ?? 0} | 流式增量帧：${deltas} | 审批次数：${approvals}`);
	console.log(`工具调用：`);
	for (const block of blocks.filter((b) => b.kind === "tool")) {
		console.log(
			`  · ${block.name} ${block.status}${block.exitCode === undefined ? "" : ` (exit ${block.exitCode})`} —— ${block.argsSummary}`,
		);
		console.log(`    输出：${JSON.stringify(block.outputExcerpt.slice(0, 160))}`);
	}
	const text = blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
	console.log(`助手文本（尾 300 字）：${JSON.stringify(text.slice(-300))}`);

	const helloPath = join(workspace, "hello.txt");
	const fileOk = existsSync(helloPath) && readFileSync(helloPath, "utf8").trim() === "hi";
	console.log(`hello.txt 真的被创建且内容为 hi：${fileOk}`);
	console.log(`工作区文件：${readdirSync(workspace).join(", ")}`);

	const logPath = join(dataDir, "logs", "agent-web.log");
	console.log(`日志文件存在：${existsSync(logPath)}`);
	if (existsSync(logPath)) {
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		const parsed = lines.map((line) => JSON.parse(line));
		console.log(`日志行数：${lines.length} | 全部是合法 JSON：${parsed.length === lines.length}`);
		console.log(`日志 scope 样例：${[...new Set(parsed.map((l) => l.scope))].join(", ")}`);
		console.log(`日志里是否出现明文 key（应为 false）：${readFileSync(logPath, "utf8").includes("sk-")}`);
	}
	const rulesPath = join(dataDir, "approval-rules.json");
	console.log(
		`审批规则已落盘：${existsSync(rulesPath)} → ${existsSync(rulesPath) ? readFileSync(rulesPath, "utf8").replace(/\s+/g, " ").slice(0, 200) : ""}`,
	);

	socket.close();
} catch (error) {
	console.log(`\n❌ 真实链路失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
	server.kill("SIGTERM");
	await sleep(600);
	if (server.exitCode === null) server.kill("SIGKILL");
	console.log(`\n清理：工作区 ${workspace}，数据目录 ${dataDir}（保留以便你查看，可手工删除）`);
	rmSync(join(dataDir, "server.lock"), { force: true });
}
