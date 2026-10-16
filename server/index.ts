/**
 * 入口（ADR-0004：一个 HTTP 端口 + 一条 WS；ADR-0006：只绑 loopback + 握手校验）。
 *
 * M1 用**假引擎**（ADR-0009：零 token 跑全链路）；真实 pi SDK 在 M3 换上
 * （只换 `server/engine/` 里的实现，这个文件不需要改）。
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createFakeEngine } from "./engine/fake.js";
import { PROTOCOL_VERSION, parseClientRequest, type ProtocolError, type ServerReply } from "./protocol.js";
import { createRuntime } from "./session/runtime.js";
import { createSender, type OutFrame } from "./snapshot/sender.js";
import { readConfig, validateConfig } from "./util/env.js";
import { createLogger } from "./util/log.js";
import { describePolicy, isAllowedHost, isAllowedOrigin } from "./util/origin.js";
import { pickExisting, webDistCandidates } from "./util/paths.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 开发态前端端口（vite），生产态不需要（ADR-0007） */
const DEV_WEB_PORT = 5174;
/** 快照节流窗口（ADR-0004 §3） */
const SNAPSHOT_WINDOW_MS = 60;
const TICK_MS = 20;
/** socket 积压阈值：超过就只发事件、丢快照（ADR-0004 §4） */
const BACKPRESSURE_BYTES = 256 * 1024;

const { config, problems: envProblems } = readConfig(process.env, { home: homedir(), cwd: process.cwd() });
const logger = createLogger({ level: config.logLevel, scope: "app" });
const problems = [...envProblems, ...validateConfig(config, { home: homedir() })];

if (problems.length > 0) {
	for (const problem of problems) logger.error(`启动自检失败：${problem}`);
	process.exit(1);
}

const policy = { port: config.port, devPorts: [DEV_WEB_PORT] };
const engine = createFakeEngine();
const sockets = new Set<WebSocket>();

const sender = createSender({
	windowMs: SNAPSHOT_WINDOW_MS,
	send: (frame: OutFrame) => {
		if (frame.kind === "snapshot") {
			broadcast(JSON.stringify({ type: "event", event: "snapshot", snapshot: frame.snapshot }));
		}
	},
});

const runtime = createRuntime({
	engine,
	workspace: config.workspace,
	emit: {
		snapshot: (snapshot) => sender.pushSnapshot(snapshot),
		event: (event) => {
			// 事件与应答绝不丢（ADR-0004 §4）：不经过节流窗口，直接下发
			broadcast(JSON.stringify(event));
		},
	},
});

function broadcast(payload: string): void {
	for (const socket of sockets) {
		if (socket.readyState === socket.OPEN) socket.send(payload);
	}
}

function reply(socket: WebSocket, id: string, result: { ok: true } | { ok: false; error: ProtocolError }): void {
	const message: ServerReply = result.ok
		? { type: "reply", id, ok: true }
		: { type: "reply", id, ok: false, error: result.error };
	socket.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
// 开发态（tsx 跑源码）与生产态（node 跑 dist/）的层数不同，两个候选都试（见 util/paths.ts）
const webDist = pickExisting(webDistCandidates(HERE), existsSync);

app.get("/api/health", (_request, response) => {
	response.json({
		ok: true,
		protocolVersion: PROTOCOL_VERSION,
		workspace: config.workspace,
		engine: "fake",
	});
});

if (webDist) {
	app.use(express.static(webDist));
} else {
	app.get("/", (_request, response) => {
		response
			.type("text/plain")
			.send(`agent-web 服务已启动（M1）\n\n前端开发态请用：npm run dev（vite 在 http://127.0.0.1:${DEV_WEB_PORT}）\n`);
	});
}

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
				const result = await runtime.sendMessage(request.payload.text);
				reply(socket, request.id, result);
				return;
			}
			case "interrupt": {
				const result = await runtime.interrupt();
				reply(socket, request.id, result);
				return;
			}
			case "approve": {
				reply(socket, request.id, runtime.approve(request.payload.requestId, request.payload.decision));
				return;
			}
			case "get_state": {
				// 重连/刷新后的第一件事：拉一份权威快照（ADR-0004 §3）
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
// 节奏：快照 tick + 心跳
// ---------------------------------------------------------------------------

const tickTimer = setInterval(() => {
	const buffered = [...sockets].reduce((max, socket) => Math.max(max, socket.bufferedAmount), 0);
	sender.setBusy(buffered > BACKPRESSURE_BYTES);
	sender.tick(Date.now());
}, TICK_MS);

const heartbeatTimer = setInterval(() => {
	for (const socket of sockets) {
		if (socket.readyState === socket.OPEN) socket.ping();
	}
}, 25_000);

httpServer.listen(config.port, config.host, () => {
	logger.info("agent-web 已启动", {
		url: `http://${config.host}:${config.port}`,
		workspace: config.workspace,
		dataDir: config.dataDir,
		engine: "fake",
		protocolVersion: PROTOCOL_VERSION,
	});
	if (!webDist) {
		logger.info("前端未构建，开发态请访问", { vite: `http://127.0.0.1:${DEV_WEB_PORT}` });
	}
});

function shutdown(signal: string): void {
	logger.info("收到退出信号，正在关闭", { signal });
	clearInterval(tickTimer);
	clearInterval(heartbeatTimer);
	sender.flush(Date.now());
	for (const socket of sockets) socket.close(1001, "server shutting down");
	wss.close();
	httpServer.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
