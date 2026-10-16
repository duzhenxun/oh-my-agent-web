/**
 * 端到端冒烟（ADR-0009 第 2 层）：真起一个 server 进程 + 真连一条 WS。
 *
 * 零 token、无外网、自包含：临时数据目录 + 专用端口（≥8900），结束自己清理。
 *
 * 覆盖（M1 协议/快照/假引擎 + M2 落盘/锁 + M3 审批规则）：
 *   握手校验（合法/非法 Origin）→ get_state → 默认回合（流式增量）→ 工具卡 → 失败工具 →
 *   超大输出截断 → 审批三态 → 断线重连（快照恢复）→ **重启后历史仍在** → 新建/切换会话 →
 *   半行容错 + 索引重建 → 单实例锁 → 非法请求被拒 → 非法 JSON 不断连。
 *
 * ⚠️ 等待纪律：**不要**用「running.status === idle」判断「我刚发的这一轮结束了」——
 * 上一个回合结束时快照就是 idle，条件会立刻为真，于是你会把请求发给一个还在跑的会话
 * （被 session.busy 拒掉，然后一路错位）。正确做法是**等这一轮的消息出现**（消息数增加）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 8901;
// ADR-0009 纪律：取仓库根一律用 fileURLToPath(new URL(...))（Windows 下 URL.pathname 会 ENOENT）
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "agent-web-smoke-"));

const failures = [];
const check = (ok, label, detail = "") => {
	if (ok) console.log(`  ✓ ${label}`);
	else {
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
		failures.push(label);
	}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
	const started = Date.now();
	for (;;) {
		if (predicate()) return true;
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
		await sleep(20);
	}
}

function startServer(port = PORT, onStderr) {
	const child = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server/index.ts")], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			AGENT_WEB_PORT: String(port),
			AGENT_WEB_DATA_DIR: dataDir,
			AGENT_WEB_CWD: REPO_ROOT,
			AGENT_WEB_LOG: "warn",
			// 冒烟断言的是假引擎的剧本（tool/fail/huge/approve/slow），所以显式指定引擎（ADR-0016）
			AGENT_WEB_ENGINE: "fake",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
	child.stderr.on("data", (chunk) => {
		onStderr?.(String(chunk));
		process.stdout.write(`[server:err] ${chunk}`);
	});
	return child;
}

async function waitForHealth(port = PORT) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return await response.json();
		} catch {
			// 还没起来
		}
		await sleep(100);
	}
	throw new Error("server 15 秒内没起来");
}

/** 极简 WS 客户端：收集所有帧，提供等待与请求助手 */
function connect(origin) {
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin });
	const frames = [];
	let seq = 0;
	const pendingReplies = new Map();

	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		frames.push(frame);
		if (frame.type === "reply") pendingReplies.set(frame.id, frame);
	});

	const client = {
		socket,
		frames,
		opened: false,
		failed: false,
		snapshots: () =>
			frames.filter((frame) => frame.type === "event" && frame.event === "snapshot").map((frame) => frame.snapshot),
		latestSnapshot: () => {
			const snapshots = client.snapshots();
			return snapshots[snapshots.length - 1] ?? null;
		},
		events: (name) => frames.filter((frame) => frame.type === "event" && frame.event === name),
		blocks: () => (client.latestSnapshot()?.active.messages ?? []).flatMap((message) => message.blocks),
		text: () =>
			client
				.blocks()
				.map((block) => (block.kind === "text" ? block.text : ""))
				.join(""),
		send(type, payload) {
			const id = `smoke-${++seq}`;
			socket.send(JSON.stringify(payload === undefined ? { id, type } : { id, type, payload }));
			return id;
		},
		sendRaw(text) {
			socket.send(text);
		},
		async reply(id, timeoutMs = 10_000) {
			await waitFor(() => pendingReplies.has(id), `应答 ${id}`, timeoutMs);
			return pendingReplies.get(id);
		},
		close: () => socket.close(),
	};

	socket.on("open", () => {
		client.opened = true;
	});
	socket.on("error", () => {
		client.failed = true;
	});

	return client;
}

/** 连接 + 等首屏快照（每次重启后都要来一遍） */
async function connectReady(label = "重连成功") {
	const client = connect(`http://127.0.0.1:${PORT}`);
	await waitFor(() => client.opened, label);
	client.send("get_state");
	await waitFor(() => client.latestSnapshot() !== null, `${label} 后拿到快照`);
	return client;
}

let server = startServer();
let client = null;

try {
	console.log(`\n冒烟：端到端（端口 ${PORT}，dataDir ${dataDir}）\n`);

	const health = await waitForHealth();
	check(health.ok === true && health.protocolVersion === 1, "健康检查返回协议版本", JSON.stringify(health));
	check(health.engine === "fake", "健康检查报告当前引擎（ADR-0016）", JSON.stringify(health));

	// ---- 握手校验：非法 Origin 必须被拒（ADR-0006 核心条目）----
	const evil = connect("https://evil.example.com");
	await sleep(300);
	check(evil.opened === false, "非法 Origin 被拒绝（不建立连接）");
	evil.close();

	// ---- 正常连接 + 首屏快照 ----
	client = await connectReady("连接建立");
	check(client.latestSnapshot().active.messages.length === 0, "初始快照为空会话");

	/**
	 * 发一轮输入并等它真正结束。
	 * 判定依据：这一轮的消息已经出现在快照里（消息数 +2）且运行态回到 idle。
	 */
	async function sendTurn(text) {
		const before = client.latestSnapshot()?.active.messages.length ?? 0;
		const reply = await client.reply(client.send("send_message", { text }));
		if (!reply.ok) throw new Error(`send_message 被拒：${JSON.stringify(reply.error)}`);
		await waitFor(() => {
			const snapshot = client.latestSnapshot();
			return snapshot !== null && snapshot.active.messages.length >= before + 2 && snapshot.running.status === "idle";
		}, `回合结束（${text}）`);
		return reply;
	}

	// ---- 默认回合：流式增量 ----
	await sendTurn("hello");
	check(client.events("message_delta").length > 3, "收到多条 message_delta 增量");
	check(client.text().includes("假引擎"), "助手消息包含假引擎回复");
	check(
		client
			.latestSnapshot()
			.active.messages.map((message) => message.role)
			.join(",") === "user,assistant",
		"消息顺序为 user,assistant",
	);

	// ---- 工具卡 / 失败工具 / 超大输出 ----
	await sendTurn("tool please");
	check(
		client.blocks().some((block) => block.kind === "tool" && block.status === "ok" && block.name === "read_file"),
		"工具卡走到 ok",
	);

	await sendTurn("fail please");
	const failedTool = client.blocks().find((block) => block.kind === "tool" && block.status === "failed");
	check(failedTool !== undefined && failedTool.exitCode === 1, "失败工具带退出码 1");

	await sendTurn("huge output");
	const hugeTool = client.blocks().find((block) => block.kind === "tool" && block.truncated === true);
	check(hugeTool !== undefined && hugeTool.outputExcerpt.length === 2000, "超大输出被截断到 2000 字");

	// ---- 审批三态（ADR-0006）：允许一次 → 总是允许这类 → 不再询问 ----
	const onceTurn = client.reply(client.send("send_message", { text: "approve please" }));
	await waitFor(() => client.latestSnapshot()?.pendingApproval !== null, "审批弹窗出现在快照里");
	const approval = client.latestSnapshot().pendingApproval;
	check(
		approval.toolName === "write_file" && approval.scopeHint.includes("目录"),
		"审批快照带工具名与「这类」描述（ADR-0006：文件类取目标目录）",
	);
	check(client.latestSnapshot().running.status === "awaiting_approval", "运行状态切到 awaiting_approval");

	const onceReply = await client.reply(client.send("approve", { requestId: approval.requestId, decision: "once" }));
	check(onceReply.ok === true, "审批应答 ok");
	check((await onceTurn).ok === true, "审批后回合正常结束");
	await waitFor(() => client.text().includes("审批结果：once"), "引擎收到「允许一次」的结果");

	const alwaysTurn = client.reply(client.send("send_message", { text: "approve please" }));
	await waitFor(() => client.latestSnapshot()?.pendingApproval !== null, "第二次仍然要问（允许一次不被记住）");
	const secondApproval = client.latestSnapshot().pendingApproval;
	const alwaysReply = await client.reply(
		client.send("approve", { requestId: secondApproval.requestId, decision: "always" }),
	);
	check(alwaysReply.ok === true, "「总是允许这类」有应答");
	check((await alwaysTurn).ok === true, "选择「总是允许这类」后回合正常结束");

	let askedAgain = false;
	const watcher = setInterval(() => {
		if (client.latestSnapshot()?.pendingApproval) askedAgain = true;
	}, 5);
	const thirdReply = await client.reply(client.send("send_message", { text: "approve once more" }));
	clearInterval(watcher);
	check(thirdReply.ok === true, "第三次同类操作正常结束");
	check(askedAgain === false, "「总是允许这类」之后不再询问");

	// ---- 断线重连：流式当中断开（≈刷新页面）→ 重连拉快照，状态与已生成正文都还在 ----
	client.send("send_message", { text: "slow please" });
	await waitFor(() => client.latestSnapshot()?.running.status === "streaming", "慢速回合开跑");
	await sleep(150);
	const streamedBefore = client.latestSnapshot().running.streamingText.length;
	client.close(); // 这一轮的应答会发给已死的 socket，所以不要等它

	const reconnected = await connectReady("重连成功");
	await waitFor(() => reconnected.latestSnapshot()?.running.status === "streaming", "重连后的快照仍显示「正在跑」");
	check(reconnected.text().includes("慢慢说"), "重连后拿回了已生成的部分正文");
	check(
		reconnected.latestSnapshot().running.streamingText.length >= streamedBefore,
		"重连后 streamingText 不丢（断线期间服务端继续干活）",
	);

	const conversationId = reconnected.latestSnapshot().active.conversationId;
	const interruptReply = await reconnected.reply(reconnected.send("interrupt", { conversationId }));
	check(interruptReply.ok === true, "中断应答 ok");
	await waitFor(() => reconnected.latestSnapshot()?.running.status === "idle", "中断后回到 idle");
	check(
		reconnected.latestSnapshot().running.streamingText === "" &&
			reconnected.latestSnapshot().notices.some((notice) => notice.text.includes("中断")),
		"中断后 running.streamingText 清空并给出提示",
	);
	client = reconnected;

	// ---- 服务重启（M2）：历史必须还在 ----
	client.close();
	server.kill("SIGTERM");
	await sleep(400);
	server = startServer();
	await waitForHealth();
	client = await connectReady("服务重启后重连");
	const sidebar = client.latestSnapshot().conversations;
	check(sidebar.length >= 1, "重启后侧栏仍有会话（M2 落盘生效）", `实际 ${sidebar.length} 个`);
	check(client.latestSnapshot().active.conversationId === null, "重启后不自动占用会话（等用户点开）");

	const targetId = sidebar[0].id;
	const switchReply = await client.reply(client.send("switch_conversation", { conversationId: targetId }));
	check(switchReply.ok === true, "切换会话有 ok 应答");
	await waitFor(() => (client.latestSnapshot()?.active.messages.length ?? 0) >= 2, "历史消息从磁盘读回来");
	check(client.text().includes("假引擎"), "重启后仍能看到之前的对话内容");
	const restartTurn = await client.reply(client.send("send_message", { text: "after restart" }));
	check(restartTurn.ok === true, "重启后仍能接着聊");

	// ---- 重启后「接着聊」不能报 engine.no_session（ADR-0018 的回归点）----
	// 这是 M3 手工运行时暴露的真 bug：引擎会话是进程内的，重启后必须重建 + 注入历史。
	await sendTurn("restart-resume");
	const resumeBlocks = client.latestSnapshot().active.messages.flatMap((message) => message.blocks);
	check(
		resumeBlocks.every((block) => block.kind !== "error" || block.code !== "engine.no_session"),
		"重启后继续聊不会报 engine.no_session",
	);
	const sessionsAfterRestart = client.latestSnapshot().active.messages.length;
	check(sessionsAfterRestart >= 4, "重启后的会话能继续追加消息", `实际 ${sessionsAfterRestart} 条`);

	// ---- 新建会话（M2）----
	const newChatReply = await client.reply(client.send("new_chat"));
	check(newChatReply.ok === true, "new_chat 有 ok 应答");
	// 快照是节流的（60ms），所以「应答 ok」不等于「快照已跟上」——要等快照，不能直接断言
	await waitFor(
		() => (client.latestSnapshot()?.conversations.length ?? 0) === sidebar.length + 1,
		"新会话进了侧栏（快照已跟上）",
	);
	const afterNew = client.latestSnapshot();
	check(afterNew.active.conversationId !== targetId, "active 指向新会话");
	await waitFor(() => (client.latestSnapshot()?.active.messages.length ?? -1) === 0, "新会话是空的");

	// ---- 半行容错 + 索引重建（M2）----
	client.close();
	server.kill("SIGTERM");
	await sleep(400);
	appendFileSync(join(dataDir, "conversations", `${targetId}.jsonl`), '{"kind":"message","id":"torn","role":"assist');
	rmSync(join(dataDir, "sessions.json"));
	server = startServer();
	await waitForHealth();
	client = await connectReady("第三次重连");
	check(
		client.latestSnapshot().conversations.some((meta) => meta.id === targetId),
		"sessions.json 被删后自动从转录重建（会话没丢）",
	);
	await client.reply(client.send("switch_conversation", { conversationId: targetId }));
	await waitFor(() => (client.latestSnapshot()?.active.messages.length ?? 0) >= 2, "半行损坏的会话仍能打开");
	check(client.text().includes("假引擎"), "半行只丢自己，其余消息照常读回");

	// ---- 单实例锁（M2）：第二个进程必须明确退出 ----
	let secondStderr = "";
	const second = startServer(PORT + 1, (chunk) => {
		secondStderr += chunk;
	});
	const secondExit = await new Promise((resolve) => {
		second.on("exit", (code) => resolve(code));
		setTimeout(() => resolve("timeout"), 15_000);
	});
	check(secondExit === 1, "数据目录已被占用时第二个实例退出码为 1", `实际 ${secondExit}`);
	check(secondStderr.includes("已经有一个 agent-web"), "第二个实例明确说明「已有实例在跑」");
	check(secondStderr.includes(String(PORT)), "提示里带上已运行实例的端口");
	if (secondExit !== 1) second.kill("SIGKILL");

	// ---- 非法请求：不合法类型/载荷被明确拒绝 ----
	const badReply = await client.reply(client.send("nope"));
	check(badReply.ok === false && badReply.error.code.startsWith("protocol."), "非法请求被拒并带协议错误码");

	const badPayloadReply = await client.reply(client.send("send_message", { text: "" }));
	check(badPayloadReply.ok === false && badPayloadReply.error.code === "protocol.bad_payload", "空文本载荷被拒");

	const badSwitch = await client.reply(client.send("switch_conversation", { conversationId: "不存在" }));
	check(badSwitch.ok === false && badSwitch.error.code === "session.not_found", "切换不存在的会话被拒");

	// ---- 非法 JSON：只记日志，不断连 ----
	client.sendRaw("{ not json");
	await sleep(100);
	check(client.failed === false && client.opened === true, "非法 JSON 不会把连接搞崩");
} catch (error) {
	console.log(`  ✗ 冒烟执行失败：${error instanceof Error ? error.message : String(error)}`);
	failures.push("执行失败");
} finally {
	client?.close();
	server.kill("SIGTERM");
	await sleep(200);
	if (server.exitCode === null) server.kill("SIGKILL");
	rmSync(dataDir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.error(`❌ flow-smoke 失败：${failures.length} 项\n`);
	process.exit(1);
}
console.log("✅ flow-smoke 通过\n");
