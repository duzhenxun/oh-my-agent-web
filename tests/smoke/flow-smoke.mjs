/**
 * M1 端到端冒烟（ADR-0009 第 2 层）：真起一个 server 进程 + 真连一条 WS。
 *
 * 零 token、无外网、自包含：临时数据目录 + 专用端口（≥8900），结束自己清理。
 * 覆盖：握手校验（合法/非法 Origin）→ get_state → 默认回合（流式增量）→ 工具卡 →
 *       失败工具 → 超大输出截断 → 审批三态 → 断线重连（快照恢复）→ 非法请求被拒 → 非法 JSON 不断连。
 *
 * ⚠️ 等待纪律：**不要**用「running.status === idle」判断「我刚发的这一轮结束了」——
 * 上一个回合结束时快照就是 idle，条件会立刻为真，于是你会把请求发给一个还在跑的会话
 * （被 session.busy 拒掉，然后一路错位）。正确做法是**等这一轮的消息出现**（消息数增加）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

function startServer() {
	const child = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "server/index.ts")], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			AGENT_WEB_PORT: String(PORT),
			AGENT_WEB_DATA_DIR: dataDir,
			AGENT_WEB_CWD: REPO_ROOT,
			AGENT_WEB_LOG: "warn",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
	child.stderr.on("data", (chunk) => process.stdout.write(`[server:err] ${chunk}`));
	return child;
}

async function waitForHealth() {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
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

let server = startServer();
let client = null;

try {
	console.log(`\n冒烟：M1 端到端（端口 ${PORT}，dataDir ${dataDir}）\n`);

	const health = await waitForHealth();
	check(health.ok === true && health.protocolVersion === 1, "健康检查返回协议版本", JSON.stringify(health));

	// ---- 握手校验：非法 Origin 必须被拒（ADR-0006 核心条目）----
	const evil = connect("https://evil.example.com");
	await sleep(300);
	check(evil.opened === false, "非法 Origin 被拒绝（不建立连接）");
	evil.close();

	// ---- 正常连接 + 首屏快照 ----
	client = connect(`http://127.0.0.1:${PORT}`);
	await waitFor(() => client.opened, "WS 连接建立");
	await waitFor(() => client.latestSnapshot() !== null, "首屏快照");
	check(client.latestSnapshot().active.messages.length === 0, "初始快照为空会话");

	// ---- get_state：拉取权威快照 ----
	const stateReply = await client.reply(client.send("get_state"));
	check(stateReply.ok === true, "get_state 有应答");
	await waitFor(() => client.latestSnapshot()?.protocolVersion === 1, "快照带协议版本");

	/**
	 * 发一轮输入并等它真正结束。
	 * 判定依据：这一轮的消息已经出现在快照里（消息数 +2）且运行态回到 idle。
	 * （只看 idle 会被上一轮的残留状态骗过去 —— 见文件头注释。）
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
	const deltas = client.events("message_delta");
	check(deltas.length > 3, "收到多条 message_delta 增量", `实际 ${deltas.length}`);
	check(client.text().includes("假引擎"), "助手消息包含假引擎回复");
	check(
		client
			.latestSnapshot()
			.active.messages.map((message) => message.role)
			.join(",") === "user,assistant",
		"消息顺序为 user,assistant",
	);

	// ---- 工具卡 ----
	await sendTurn("tool please");
	check(
		client.blocks().some((block) => block.kind === "tool" && block.status === "ok" && block.name === "read_file"),
		"工具卡走到 ok",
	);

	// ---- 失败工具：状态 failed + 退出码 ----
	await sendTurn("fail please");
	const failedTool = client.blocks().find((block) => block.kind === "tool" && block.status === "failed");
	check(failedTool !== undefined && failedTool.exitCode === 1, "失败工具带退出码 1");

	// ---- 超大输出：截断 + 标记 ----
	await sendTurn("huge output");
	const hugeTool = client.blocks().find((block) => block.kind === "tool" && block.truncated === true);
	check(hugeTool !== undefined && hugeTool.outputExcerpt.length === 2000, "超大输出被截断到 2000 字");

	// ---- 审批三态（ADR-0006）：允许一次 → 总是允许这类 → 不再询问 ----
	// 第一次：允许一次
	const onceTurn = client.reply(client.send("send_message", { text: "approve please" }));
	await waitFor(() => client.latestSnapshot()?.pendingApproval !== null, "审批弹窗出现在快照里");
	const approval = client.latestSnapshot().pendingApproval;
	check(
		approval.toolName === "write_file" && approval.scopeHint.includes("write_file"),
		"审批快照带工具名与「这类」描述",
	);
	check(client.latestSnapshot().running.status === "awaiting_approval", "运行状态切到 awaiting_approval");

	const onceReply = await client.reply(client.send("approve", { requestId: approval.requestId, decision: "once" }));
	check(onceReply.ok === true, "审批应答 ok");
	check((await onceTurn).ok === true, "审批后回合正常结束");
	await waitFor(() => client.text().includes("审批结果：once"), "引擎收到「允许一次」的结果");
	await waitFor(() => client.latestSnapshot()?.pendingApproval === null, "审批已清空");

	// 第二次：选「总是允许这类」（「允许一次」不该被记住 —— 这正是三态的意义）
	const alwaysTurn = client.reply(client.send("send_message", { text: "approve please" }));
	await waitFor(() => client.latestSnapshot()?.pendingApproval !== null, "第二次仍然要问");
	const secondApproval = client.latestSnapshot().pendingApproval;
	const alwaysReply = await client.reply(
		client.send("approve", { requestId: secondApproval.requestId, decision: "always" }),
	);
	check(alwaysReply.ok === true, "「总是允许这类」有应答");
	check((await alwaysTurn).ok === true, "选择「总是允许这类」后回合正常结束");

	// 第三次：同类操作不再询问
	let askedAgain = false;
	const watcher = setInterval(() => {
		if (client.latestSnapshot()?.pendingApproval) askedAgain = true;
	}, 5);
	const thirdReply = await client.reply(client.send("send_message", { text: "approve once more" }));
	clearInterval(watcher);
	check(thirdReply.ok === true, "第三次同类操作正常结束");
	check(askedAgain === false, "「总是允许这类」之后不再询问");

	// ---- 断线重连：流式当中断开（≈刷新页面）→ 重连拉快照，状态与已生成正文都还在（ADR-0004 §6）----
	client.send("send_message", { text: "slow please" });
	await waitFor(() => client.latestSnapshot()?.running.status === "streaming", "慢速回合开跑");
	await sleep(150);
	const streamedBefore = client.latestSnapshot().running.streamingText.length;
	client.close(); // 模拟刷新页面：这一轮的应答会发给已死的 socket，所以不要等它

	const reconnected = connect(`http://127.0.0.1:${PORT}`);
	await waitFor(() => reconnected.opened, "重连成功");
	reconnected.send("get_state");
	await waitFor(
		() =>
			reconnected.latestSnapshot()?.running.status === "streaming" &&
			(reconnected.latestSnapshot()?.active.messages.length ?? 0) >= 2,
		"重连后的快照仍显示「正在跑」",
	);
	check(reconnected.text().includes("慢慢说"), "重连后拿回了已生成的部分正文");
	check(
		reconnected.latestSnapshot().running.streamingText.length >= streamedBefore,
		"重连后 streamingText 不丢（断线期间服务端继续干活）",
	);

	// 收尾：从新连接发中断，把这一轮停掉
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

	// ---- 服务重启：杀掉再拉起 → 重连后仍然可用 ----
	// ⚠️ M1 是内存态，历史重启即丢（这正是 M2「会话落盘」要解决的）；
	//    这里锁的是「重启后前端能自动重连并继续干活」，M2 会翻转「历史为空」这条预期。
	client.close();
	server.kill("SIGTERM");
	await sleep(400);
	server = startServer();
	await waitForHealth();
	const afterRestart = connect(`http://127.0.0.1:${PORT}`);
	await waitFor(() => afterRestart.opened, "服务重启后重连成功");
	afterRestart.send("get_state");
	await waitFor(() => afterRestart.latestSnapshot() !== null, "重启后拿到快照");
	check(
		afterRestart.latestSnapshot().active.messages.length === 0,
		"M1 内存态：重启后历史为空（M2 落盘后会改成「历史仍在」）",
	);
	const restartTurn = await afterRestart.reply(afterRestart.send("send_message", { text: "after restart" }));
	check(restartTurn.ok === true, "重启后仍能正常跑一轮");
	client = afterRestart;

	// ---- 非法请求：不合法类型/载荷被明确拒绝 ----
	const badReply = await client.reply(client.send("nope"));
	check(badReply.ok === false && badReply.error.code.startsWith("protocol."), "非法请求被拒并带协议错误码");

	const badPayloadReply = await client.reply(client.send("send_message", { text: "" }));
	check(badPayloadReply.ok === false && badPayloadReply.error.code === "protocol.bad_payload", "空文本载荷被拒");

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
