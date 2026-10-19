/**
 * 入口（ADR-0004：一个 HTTP 端口 + 一条 WS；ADR-0006：只绑 loopback + 握手校验；ADR-0007：单实例锁）。
 *
 * 引擎默认是**真实 pi SDK**（ADR-0003 的端口实现）；`AGENT_WEB_ENGINE=fake` 切到假引擎
 * （ADR-0009 的测试通道：零 token 跑全链路）。换引擎只换 `server/engine/` 里的实现。
 *
 * 启动顺序：环境自检 → 数据目录可写 → **抢单实例锁** → 装填会话索引 → 监听端口。
 * 顺序有意义：锁要在读/写任何会话数据**之前**拿到，否则两个进程可能同时建索引。
 */
import { homedir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createFakeEngine } from "./engine/fake.js";
import { createPiSdkEngine } from "./engine/pi-sdk.js";
import { createEngineRegistry, FAKE_CAPABILITIES, PI_CAPABILITIES } from "./engine/registry.js";
import type { EnginePort } from "./engine/port.js";
import { createFileRuleStore } from "./approval/rules.js";
import { existsSync } from "node:fs";
import { PROTOCOL_VERSION, parseClientRequest, type ProtocolError, type ServerReply } from "./protocol.js";
import { acquireLock, describeHolder, releaseLock } from "./session/lock.js";
import { createRuntime } from "./session/runtime.js";
import { createFileSettingsStore } from "./session/settings.js";
import { createSender, type OutFrame } from "./snapshot/sender.js";
import { createPiSessionsProvider, piAgentDir } from "./session/pi-sessions-provider.js";
import { createUploadStore, uploadsDir } from "./uploads/upload-store.js";
import { createProviderWiring } from "./providers/provider-handlers.js";
import { probeProvider } from "./providers/probe.js";
import { createProviderStore } from "./providers/provider-store.js";
import { registerFileRoutes } from "./files/files-routes.js";
import { registerAuxRoutes } from "./http/aux-routes.js";
import { registerHealthAndStatic } from "./http/health-and-static.js";
import { registerUploadRoutes } from "./uploads/upload-routes.js";
import { readConfig, validateConfig } from "./util/env.js";
import { createLogger } from "./util/log.js";
import { createRotatingFileSink, logFileName, type RotatingFileSink } from "./util/log-file.js";
import { describePolicy, isAllowedHost, isAllowedOrigin } from "./util/origin.js";
import { pickExisting, webDistCandidates } from "./util/paths.js";
import { checkDataDirWritable, describeListenError } from "./util/startup.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 开发态前端端口（vite），生产态不需要（ADR-0007） */
const DEV_WEB_PORT = 5174;
/** 快照节流窗口（ADR-0004 §3） */
const SNAPSHOT_WINDOW_MS = 60;
const TICK_MS = 20;
/** socket 积压阈值：超过就只发事件、丢快照（ADR-0004 §4） */
const BACKPRESSURE_BYTES = 256 * 1024;

const { config, problems: envProblems } = readConfig(process.env, { home: homedir(), cwd: process.cwd() });
let fileSink: RotatingFileSink | null = null;
const logger = createLogger({
	level: config.logLevel,
	scope: "app",
	sink: (line) => {
		process.stdout.write(`${line}\n`);
		fileSink?.write(line);
	},
});
const policy = { port: config.port, devPorts: [DEV_WEB_PORT] };

const sockets = new Set<WebSocket>();
let shuttingDown = false;

const sender = createSender({
	windowMs: SNAPSHOT_WINDOW_MS,
	send: (frame: OutFrame) => {
		if (frame.kind === "snapshot") {
			broadcast(JSON.stringify({ type: "event", event: "snapshot", snapshot: frame.snapshot }));
		}
	},
});

/** 引擎注册表（ADR-0024）：加引擎 = 写适配文件 + 注册一行 */
const engineRegistry = createEngineRegistry([
	{
		name: "pi",
		label: "pi",
		capabilities: PI_CAPABILITIES,
		create: () =>
			createPiSdkEngine({
				onNotice: (text, level) => {
					logger.warn(text, { engine: "pi" });
					// 引擎层的异常也要让用户看见（否则只在日志里，界面上像是卡住了）
					runtimeRef.current?.notify(text, level);
				},
			}),
	},
	{ name: "fake", label: "假引擎", capabilities: FAKE_CAPABILITIES, create: () => createFakeEngine() },
]);

/** 引擎选择（ADR-0016 + ADR-0024）：默认 pi；未知名字回落到 pi 并告警 */
const resolved = engineRegistry.resolve(config.engine);
if (resolved.fallbackFrom) {
	logger.warn("AGENT_WEB_ENGINE 未注册，回落到 pi", {
		requested: resolved.fallbackFrom,
		known: engineRegistry.names(),
	});
}
const engine: EnginePort = resolved.engine;

/** 引擎在 runtime 建好之前就会创建，用一个 ref 把「通知」转发给界面 */
/** provider 配置存储（ADR-0025）：复用 pi 自己的 models-store.json / auth.json */
const providerStore = createProviderStore({ agentDir: piAgentDir(), now: Date.now });

const runProviderRequest = createProviderWiring({
	store: providerStore,
	logger,
	probe: probeProvider,
	getRuntime: () => runtime,
});

const runtimeRef: { current: { notify: (text: string, level?: "info" | "warn" | "error") => void } | null } = {
	current: null,
};

const runtime = createRuntime({
	engine,
	rules: createFileRuleStore(config.dataDir),
	// 启动信息只进日志，不进对话流
	onStartupInfo: (text) => logger.info(text),
	workspace: config.workspace,
	engineName: resolved.descriptor.name,
	engineCapabilities: resolved.descriptor.capabilities,
	turnTimeoutMs: config.turnTimeoutMs,
	settings: createFileSettingsStore(config.dataDir),
	uploadStore: {
		read: (id) => uploadStore.read(id),
		pathOf: (id) => join(uploadsDir(config.dataDir), id),
	},
	piSessions: createPiSessionsProvider({
		agentDir: piAgentDir(),
		dataDir: config.dataDir,
		logger,
	}),
	emit: {
		snapshot: (snapshot) => sender.pushSnapshot(snapshot),
		event: (event) => {
			broadcast(JSON.stringify(event));
		},
	},
});

runtimeRef.current = runtime;

function broadcast(payload: string): void {
	for (const socket of sockets) {
		if (socket.readyState === socket.OPEN) socket.send(payload);
	}
}

function reply(
	socket: WebSocket,
	id: string,
	result: { ok: true; result?: unknown } | { ok: false; error: ProtocolError },
): void {
	const message: ServerReply = result.ok
		? { type: "reply", id, ok: true, ...(result.result === undefined ? {} : { result: result.result }) }
		: { type: "reply", id, ok: false, error: result.error };
	socket.send(JSON.stringify(message));
}

// ------------------------------ HTTP ------------------------------

const app = express();
app.use(express.json()); // 终端/技能/导入要读 body
const webDist = pickExisting(webDistCandidates(HERE), existsSync);
const uploadStore = createUploadStore({ dataDir: config.dataDir });
registerUploadRoutes(app, { uploadStore, logger }); // 附件（ADR-0020 §P3）

const workspaceOf = () => runtime.state().files?.root ?? config.workspace;
registerAuxRoutes(app, {
	providerStore,
	workspaceOf,
	onChange: () => void runProviderRequest({ type: "list_providers" }, () => {}),
});
registerFileRoutes(app, { workspaceOf }); // 文件浏览（M4）
registerHealthAndStatic(app, {
	workspace: config.workspace,
	engine: config.engine,
	webDist,
	devWebPort: DEV_WEB_PORT,
	counts: () => ({
		sessions: runtime.state().piProjects.reduce((total, project) => total + project.sessions.length, 0),
		conversations: runtime.state().conversations.length,
	}),
});

const httpServer = createServer(app);

// ---------------------------------------------------------------------------
// WebSocket（握手校验是 ADR-0006 的核心条目）
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
	const origin = request.headers.origin;
	const host = request.headers.host;
	if (!isAllowedOrigin(origin, policy) || !isAllowedHost(host, policy)) {
		logger.warn("拒绝 WS 握手：来源不在白名单", { origin, host, policy: describePolicy(policy) });
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket));
});

wss.on("connection", (socket: WebSocket) => {
	sockets.add(socket);
	logger.info("客户端已连接", { clients: sockets.size });

	// 首屏：立刻给一份快照，不等节流窗口
	sender.pushSnapshot(runtime.snapshot());
	sender.flush(Date.now());

	socket.on("message", (raw) => {
		void handleMessage(socket, raw.toString());
	});

	socket.on("close", () => {
		sockets.delete(socket);
		logger.info("客户端已断开", { clients: sockets.size });
	});

	socket.on("error", (error: Error) => {
		logger.warn("socket 错误", { message: error.message });
		sockets.delete(socket);
	});
});

async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		logger.warn("收到非法 JSON，已忽略");
		return;
	}

	const request = parseClientRequest(parsed);
	if (!request) {
		const id = typeof (parsed as { id?: unknown })?.id === "string" ? (parsed as { id: string }).id : "unknown";
		const type = (parsed as { type?: unknown })?.type;
		const error: ProtocolError =
			typeof type === "string"
				? { code: "protocol.bad_payload", message: `请求 ${type} 的载荷不合法` }
				: { code: "protocol.unknown_type", message: "无法识别的请求" };
		logger.warn("拒绝非法请求", { id, type, code: error.code });
		reply(socket, id, { ok: false, error });
		return;
	}

	try {
		switch (request.type) {
			case "send_message": {
				reply(socket, request.id, await runtime.sendMessage(request.payload.text, request.payload.attachments));
				return;
			}
			case "interrupt":
				reply(socket, request.id, await runtime.interrupt());
				return;
			case "approve":
				reply(socket, request.id, runtime.approve(request.payload.requestId, request.payload.decision));
				return;
			case "new_chat":
				reply(socket, request.id, await runtime.newConversation(request.payload?.workspace));
				return;
			case "switch_conversation":
				reply(socket, request.id, await runtime.switchConversation(request.payload.conversationId));
				return;
			case "list_providers":
			case "upsert_provider":
			case "delete_provider":
			case "test_provider":
			case "update_model":
				return void (await runProviderRequest(request, (result) => reply(socket, request.id, result)));
			case "set_approval_mode": {
				reply(socket, request.id, runtime.setApprovalMode(request.payload.mode));
				return;
			}
			case "set_thinking_level":
				reply(socket, request.id, await runtime.setThinkingLevel(request.payload.level));
				return;
			case "set_model": {
				reply(socket, request.id, await runtime.setModel(request.payload.modelId));
				return;
			}
			case "set_settings": {
				reply(socket, request.id, await runtime.applySettings(request.payload));
				return;
			}
			case "get_state": {
				// 重连/刷新后的第一件事：拉一份权威快照（ADR-0004 §3）；顺便刷一次 pi 会话列表（带 10s 下限）
				await runtime.refreshPiSessions();
				sender.pushSnapshot(runtime.snapshot());
				sender.flush(Date.now());
				reply(socket, request.id, { ok: true });
				return;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("处理请求失败", { type: request.type, message });
		reply(socket, request.id, { ok: false, error: { code: "protocol.handler_failed", message } });
	}
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const problems = [...envProblems, ...validateConfig(config, { home: homedir() })];
	if (problems.length > 0) {
		for (const problem of problems) logger.error(`启动自检失败：${problem}`);
		process.exit(1);
	}

	const writable = await checkDataDirWritable(config.dataDir);
	if (!writable.ok) {
		logger.error(`启动自检失败：${writable.reason}`);
		process.exit(1);
	}

	// 日志自己也住在数据目录里 → 确认可写之后再挂文件 sink
	fileSink = createRotatingFileSink({ file: logFileName(config.dataDir), onError: (message) => logger.warn(message) });

	// 单实例锁（ADR-0007）：必须在读/写任何会话数据之前拿到
	const acquired = await acquireLock(config.dataDir, { pid: process.pid, port: config.port, startedAt: Date.now() });
	if (!acquired.ok) {
		logger.error("已经有一个 agent-web 在跑，本进程退出", { holder: describeHolder(acquired.holder) });
		console.error(`\n已经有一个 agent-web 在这个数据目录上跑着：\n  ${describeHolder(acquired.holder)}\n`);
		console.error(`  → 打开它：http://127.0.0.1:${acquired.holder.port}`);
		console.error("  → 或者先停掉它（前台运行时 Ctrl-C 即可）\n");
		process.exit(1);
	}
	if (acquired.stale && acquired.previous) {
		logger.warn("接管陈旧锁（上一个进程已不在）", { previous: describeHolder(acquired.previous) });
	}

	const { conversations } = await runtime.init().then(() => ({ conversations: runtime.state().conversations }));
	void runProviderRequest({ type: "list_providers" }, () => {}); // 启动先填一次 provider 列表
	logger.info("会话索引已装载", { conversations: conversations.length });

	httpServer.on("error", (error: NodeJS.ErrnoException) => {
		logger.error(describeListenError(error, config.port, `可能是另一个 agent-web 或别的程序占着这个端口`));
		void releaseLock(config.dataDir, process.pid).finally(() => process.exit(1));
	});

	await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));

	logger.info("agent-web 已启动", {
		url: `http://${config.host}:${config.port}`,
		workspace: config.workspace,
		dataDir: config.dataDir,
		engine: config.engine,
		protocolVersion: PROTOCOL_VERSION,
		conversations: runtime.state().conversations.length,
	});
	if (!webDist) {
		logger.info("前端未构建，开发态请访问", { vite: `http://127.0.0.1:${DEV_WEB_PORT}` });
	}

	setInterval(() => {
		const buffered = [...sockets].reduce((max, socket) => Math.max(max, socket.bufferedAmount), 0);
		sender.setBusy(buffered > BACKPRESSURE_BYTES);
		sender.tick(Date.now());
	}, TICK_MS);

	setInterval(() => {
		for (const socket of sockets) {
			if (socket.readyState === socket.OPEN) socket.ping();
		}
	}, 25_000);
}

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("收到退出信号，正在关闭", { signal });
	sender.flush(Date.now());
	for (const socket of sockets) socket.close(1001, "server shutting down");
	wss.close();
	httpServer.close();
	// 锁要还回去：只有还属于自己时才删（避免删掉接管者的锁）
	await releaseLock(config.dataDir, process.pid);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
	logger.error("启动失败", { message: error instanceof Error ? error.message : String(error) });
	process.exit(1);
});
