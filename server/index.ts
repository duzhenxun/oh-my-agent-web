/**
 * 入口：一个 HTTP 端口 + 实时通道（WS 或 SSE/RPC，ADR-0032）。
 */
import { homedir, networkInterfaces } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createEngineWiring } from "./engine/wiring.js";
import type { EnginePort } from "./engine/port.js";
import { createFileRuleStore } from "./approval/rules.js";
import { existsSync } from "node:fs";
import { PROTOCOL_VERSION, type ProtocolError, type ServerReply } from "./protocol.js";
import { acquireLock, describeHolder, releaseLock } from "./session/lock.js";
import { createRuntime } from "./session/runtime.js";
import { createFileSettingsStore } from "./session/settings.js";
import { createSender, type OutFrame } from "./snapshot/sender.js";
import { createPiSessionsProvider, piAgentDir } from "./session/pi-sessions-provider.js";
import { createUploadStore, uploadsDir } from "./uploads/upload-store.js";
import { builtinProviderGroups, createProviderWiring } from "./providers/provider-handlers.js";
import { probeProvider } from "./providers/probe.js";
import { createProviderStore } from "./providers/provider-store.js";
import { createEnabledStore } from "./providers/enabled-models.js";
import { migrateStoreToCatalog } from "./providers/catalog-writes.js";
import { createPushStore, notifyTurnFinished } from "./push/push.js";
import { registerAuxRoutes } from "./http/aux-routes.js";
import { handleMessage } from "./ws/handle-message.js";
import { registerHealthAndStatic } from "./http/health-and-static.js";
import { registerUploadRoutes } from "./uploads/upload-routes.js";
import { readConfig, validateConfig } from "./util/env.js";
import { createLogger } from "./util/log.js";
import { createRotatingFileSink, logFileName, type RotatingFileSink } from "./util/log-file.js";
import { refreshPriceIndex } from "./util/pricing-index.js";
import { describePolicy, isAllowedHost, isAllowedOrigin } from "./util/origin.js";
import { pickExisting, webDistCandidates } from "./util/paths.js";
import { authMiddleware, decide, effectiveAddress } from "./http/auth.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { BRAND_NAME } from "./brand.js";
import { registerLiveRoutes, type Sink } from "./http/live-routes.js";
import { compressText, immutableAssets } from "./http/compress.js";
import { fanOutSnapshot } from "./snapshot/fan-out.js";
import { checkDataDirWritable, describeListenError } from "./util/startup.js";
import { migrateLegacyDataDir } from "./util/data-dir.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 开发态对外端口（Vite）；dev 脚本用它告诉后端可信来源 */
const DEV_WEB_PORT = Number(process.env.AGENT_WEB_DEV_PORT ?? 25257);
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
// 单用户工作台：一处 fire-and-forget 的 Promise 拒绝（推送写盘失败、模型热重载失败……）
// 不该把整个服务带走（Node ≥15 默认会直接退出）。记日志、继续跑。
process.on("unhandledRejection", (reason) => {
	logger.error("未处理的 Promise 拒绝（已记录，进程继续）", {
		message: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
	});
});

/** 局域网地址自动放行；域名仍要显式配 */
const localAddresses = Object.values(networkInterfaces())
	.flat()
	.filter((item): item is NonNullable<typeof item> => Boolean(item) && item?.internal === false)
	.map((item) => item.address);

const policy = {
	port: config.port,
	devPorts: [DEV_WEB_PORT],
	extraHosts: [...new Set([...localAddresses, ...config.allowedHosts])],
};

const sockets = new Set<WebSocket>();
let shuttingDown = false;

const sender = createSender({
	windowMs: SNAPSHOT_WINDOW_MS,
	send: (frame: OutFrame) => {
		if (frame.kind === "snapshot") fanOut(frame.snapshot);
	},
});

const piSessions = createPiSessionsProvider({ agentDir: piAgentDir(), dataDir: config.dataDir, logger });

/** 引擎接线：注册表 + codex 客户端 + 每个引擎的会话来源（engine/wiring.ts） */
const engineWiring = createEngineWiring({
	engineName: config.engine,
	codexBin: config.codexBin,
	codexHome: config.codexHome,
	dshBin: config.dshBin,
	dshHome: config.dshHome,
	dshModel: config.dshModel,
	dshPatches: config.dshPatches,
	dshPatchDir: join(config.dataDir, "dsh-patches"),
	piSessions,
	onNotice: (text, level) => runtimeRef.current?.notify(text, level),
	onLog: (text, meta) => logger.warn(text, meta),
});
const engineCatalog = engineWiring.catalog;
const resolved = engineWiring.resolved;
const engine: EnginePort = resolved.engine;

/** 引擎在 runtime 建好之前就会创建，用一个 ref 把「通知」转发给界面 */
/** provider 配置存储（ADR-0025）：复用 pi 自己的 models-store.json / auth.json */
const providerStore = createProviderStore({ agentDir: piAgentDir(), now: Date.now });
/** 启动时的配置补齐（main 里会 await 它：避免和价格索引抢着读同一个文件） */
const catalogMigration = migrateStoreToCatalog(piAgentDir()).then((migrated) => {
	if (migrated.length > 0) logger.info("已把老 provider 补进 models.json", { providers: migrated });
});
const enabledStore = createEnabledStore({ agentDir: piAgentDir() });
const pushStore = createPushStore({ dataDir: config.dataDir, now: Date.now });

const runProviderRequest = createProviderWiring({
	store: providerStore,
	logger,
	probe: probeProvider,
	enabled: enabledStore,
	getRuntime: () => runtime,
});

const runtimeRef: { current: { notify: (text: string, level?: "info" | "warn" | "error") => void } | null } = {
	current: null,
};
/** 懒读：provider 列表里要带上内置 provider 分组，而那需要 runtime 里的模型表 */
const providerList = async () => {
	const list = await providerStore.list(builtinProviderGroups(runtime?.state().models ?? []));
	const live = runtime?.state();
	if (live) live.enabledModels = await enabledStore.read();
	return list;
};

const runtime = createRuntime({
	engine,
	// 自定义 provider 来自 models-store.json；不主动读一次，界面上就只剩内置的那几个
	loadProviders: providerList,
	onTurnFinished: (info) => notifyTurnFinished(pushStore, info),
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
	piSessions: engineCatalog.sessionsFor(resolved.descriptor.name) ?? undefined,
	engines: engineCatalog,
	emit: {
		snapshot: (snapshot) => sender.pushSnapshot(snapshot),
		event: (event) => {
			broadcast(JSON.stringify(event));
		},
	},
});

runtimeRef.current = runtime;

/** SSE 连接（纯 HTTP 通道）：clientId → 写入函数（每客户端一份快照，ADR-0033） */
const sinks = new Map<string, Sink>();

const fanOut = (snapshot: Parameters<typeof fanOutSnapshot>[0]) =>
	fanOutSnapshot(snapshot, { sockets, sinks, snapshotFor: (id) => runtime.snapshotFor(id) });

function broadcast(payload: string): void {
	for (const socket of sockets) {
		if (socket.readyState === socket.OPEN) socket.send(payload);
	}
	for (const sink of sinks.values()) sink(payload);
}

async function dispatchRequest(socket: WebSocket, raw: string, clientId?: string): Promise<void> {
	await handleMessage(socket, raw, {
		runtime,
		...(clientId ? { clientId } : {}),
		reply,
		sender,
		logger,
		runProviderRequest: (request, respond) => runProviderRequest(request, (result) => respond(result)),
	});
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
// 登录端点必须挂在鉴权**之前**：此刻还没有 cookie，不能要求先过鉴权（ADR-0031 修订）
registerAuthRoutes(app, { password: config.password, brandName: BRAND_NAME });
// 鉴权其次：本机放行，其它来源必须过密码；页面请求给登录页，接口请求给 401
app.use(authMiddleware({ password: config.password, brandName: BRAND_NAME }));
app.use(express.json()); // 终端/技能/导入要读 body
const webDist = pickExisting(webDistCandidates(HERE), existsSync);
// 压缩 + 缓存头必须在 **API 路由注册之前** 挂：Express 按注册顺序匹配中间件，
// 挂在后面就只影响之后注册的路由 —— `/api/rpc`（快照帧）这类大包会一直裸奔。
// SSE / 终端流 / Range 媒体在 compress.ts 里显式跳过（不能攒、不能压）。
app.use(compressText());
app.use(immutableAssets());
const uploadStore = createUploadStore({ dataDir: config.dataDir });
registerUploadRoutes(app, { uploadStore, logger }); // 附件（ADR-0020 §P3）

const workspaceOf = () => runtime.state().files?.root ?? config.workspace;
registerAuxRoutes(app, {
	providerStore,
	workspaceOf,
	projects: () => runtime.state().piProjects,
	deleteSession: (id) => runtime.deleteSession(id),
	pushStore,
	onChange: () => void runProviderRequest({ type: "list_providers" }, () => {}),
});

registerLiveRoutes(app, {
	sinks,
	snapshotFor: (clientId) => runtime.snapshotFor(clientId),
	clientTracker: { setSlim: runtime.clientView.setSlim, drop: runtime.clientView.drop },
	logger,
	handleMessage: async (clientId, shim, raw) => {
		await dispatchRequest(shim as unknown as WebSocket, raw, clientId);
	},
});

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
	// WS 不走 Express 中间件，得在这里单独判一次
	const forwarded = request.headers["x-forwarded-for"];
	const auth = decide({
		password: config.password,
		remoteAddress: effectiveAddress(
			request.socket.remoteAddress,
			typeof forwarded === "string" ? forwarded : undefined,
		),
		authorization: request.headers.authorization,
		cookie: request.headers.cookie,
	});
	if (auth !== "allow") {
		// 不发 WWW-Authenticate：那会让浏览器弹原生登录框，与自建登录页重复
		socket.write(auth === "forbid" ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
		socket.destroy();
		return;
	}
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
		void dispatchRequest(socket, raw.toString());
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

// 客户端请求分发在 ws/handle-message.ts（index 只负责装配）

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// 旧数据目录（~/.agent-web）自动搬到新目录：dev 直接跑本文件时也要搬
	migrateLegacyDataDir({ dataDir: config.dataDir, log: (line) => logger.info(line) });
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
	// 分时价格索引（ADR-0026 D 期）：要在读历史 / 算账之前就绪；读不到就是空表 = 全部走引擎给的 cost
	await catalogMigration.catch(() => undefined);
	await refreshPriceIndex(piAgentDir());
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
	engineWiring.close(); // 收掉 codex app-server 子进程（不给它留孤儿）
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
