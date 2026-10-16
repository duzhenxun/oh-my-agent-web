/**
 * 「重启后接着聊，而且模型还记得」的真实链路验收（ADR-0018）。
 *
 * 手工跑：node --import tsx scripts/live-resume-check.mjs
 * 用临时工作区与临时数据目录，绝不动真实数据。两次小往返（约几千 token）。
 *
 * 为什么需要这个脚本：单元/冒烟测的是假引擎，而这条链路的坑（引擎会话是进程内的、
 * 历史必须注入）只有真引擎才暴露得出来 —— 之前就是这么漏掉的。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 8796;
const workspace = mkdtempSync(join(tmpdir(), "agent-web-resume-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "agent-web-resume-data-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
	const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			AGENT_WEB_PORT: String(PORT),
			AGENT_WEB_DATA_DIR: dataDir,
			AGENT_WEB_CWD: workspace,
			AGENT_WEB_ENGINE: "pi",
			AGENT_WEB_LOG: "warn",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr.on("data", (chunk) => process.stdout.write(`[server:err] ${chunk}`));
	return child;
}

async function waitForHealth() {
	for (let index = 0; index < 80; index += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (response.ok) return;
		} catch {
			// 还没起来
		}
		await sleep(150);
	}
	throw new Error("server 没起来");
}

/** 连上、可选切会话、发一轮、等回合结束，返回快照与错误块 */
async function turn(text, conversationId) {
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
	const frames = [];
	socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	const snapshots = () =>
		frames.filter((frame) => frame.type === "event" && frame.event === "snapshot").map((frame) => frame.snapshot);

	await sleep(300);
	if (conversationId) {
		socket.send(JSON.stringify({ id: "r-switch", type: "switch_conversation", payload: { conversationId } }));
		await sleep(400);
	}
	const before = snapshots().at(-1)?.active.messages.length ?? 0;
	socket.send(JSON.stringify({ id: "r-msg", type: "send_message", payload: { text } }));

	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const snapshot = snapshots().at(-1);
		if (snapshot && snapshot.active.messages.length >= before + 2 && snapshot.running.status === "idle") break;
		await sleep(300);
	}
	const final = snapshots().at(-1);
	const blocks = (final?.active.messages ?? []).flatMap((message) => message.blocks);
	const reply = blocks
		.slice(before)
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("");
	const errors = (final?.active.messages ?? [])
		.flatMap((message) => message.blocks)
		.filter((block) => block.kind === "error");
	socket.close();
	return {
		conversationId: final?.active.conversationId,
		messageCount: final?.active.messages.length ?? 0,
		reply,
		errors,
		model: final?.model,
	};
}

let server = startServer();
try {
	await waitForHealth();
	console.log(`\n工作区：${workspace}\n数据目录：${dataDir}\n`);

	const first = await turn("请记住一个数字：42。只回复「记住了」两个字。", null);
	console.log(`[第 1 轮] 会话=${first.conversationId} 消息=${first.messageCount} 模型=${first.model}`);
	console.log(`        回复：${JSON.stringify(first.reply.slice(-80))}`);
	if (first.errors.length > 0) console.log(`        错误：${JSON.stringify(first.errors)}`);

	// ---- 重启服务（模拟你关掉再开）----
	console.log("\n>>> 重启服务（会话在磁盘上，引擎会话在进程里 —— 这正是要验证的地方）");
	server.kill("SIGTERM");
	await sleep(800);
	server = startServer();
	await waitForHealth();
	console.log(">>> 重启完成\n");

	const second = await turn("我刚才让你记住的数字是多少？只回答那个数字，不要解释。", first.conversationId);
	console.log(`[第 2 轮] 会话=${second.conversationId} 消息=${second.messageCount} 模型=${second.model}`);
	console.log(`        回复：${JSON.stringify(second.reply.slice(-120))}`);

	const noSession = second.errors.some((block) => block.code === "engine.no_session");
	const remembered = second.reply.includes("42");
	console.log(`\n结果：`);
	console.log(`  重启后能继续（没有 engine.no_session）：${!noSession}`);
	console.log(`  模型记得上一轮的数字（回复含 42）：${remembered}`);
	if (!noSession && remembered) console.log("\n✅ 重启后接着聊 + 历史注入 都成立\n");
	else console.log("\n❌ 未达成（见上面输出）\n");
} catch (error) {
	console.log(`❌ 失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
	server.kill("SIGTERM");
	await sleep(600);
	if (server.exitCode === null) server.kill("SIGKILL");
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
	console.log("（临时数据目录已清理）");
}
