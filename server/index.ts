/**
 * open-web-app server — express + WebSocket hub in front of the codex app-server.
 *
 *   browser  <--ws /ws-->  [this]  <--ws-->  codex app-server (ws://127.0.0.1:25258)
 *
 * 我们是「透明 JSON-RPC 代理 + 进程守护」：
 *  - 浏览器可以按名字调用任意 codex 方法；所有 codex 通知原样广播。
 *  - `cw/*` 是本地方法（状态 / 日志 / 文件系统 / 路径），由本进程处理。
 *  - codex 反向请求（审批 / user input / 动态工具）广播给所有标签页，谁先 reply 谁赢，
 *    随后广播 `serverRequest/resolved` 让其他标签页关掉弹窗。
 *  - 同一 `dist/server/index.js` 既能被 CLI `startServer()` 调用，也能直接 `node` 运行。
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import type { Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { CodexClient } from "./codex-client.js";
import { CodexSupervisor } from "./codex-supervisor.js";
import { RequestInspector } from "./request-inspector.js";
import { FsError, listDirectory, paths as resolvePaths, readTextFile } from "./fs-service.js";
import {
	LOCAL_METHODS,
	PROTOCOL_VERSION,
	type ClientMessage,
	type JsonRpcError,
	type RequestId,
	type ServerInfo,
	type ServerMessage,
} from "../shared/protocol.js";

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_CW_PORT = 25257;
const DEFAULT_CW_HOST = "127.0.0.1";
const DEFAULT_CODEX_PORT = 25258;
const DEFAULT_CODEX_BIN = "codex";
const HEARTBEAT_MS = 30_000;
const SERVER_REQUEST_HISTORY = 2_000;
/**
 * How long a proxied `codex/*` call waits for the app-server before giving up
 * with `-32001`. Long enough to cover a cold `codex app-server` boot (and a
 * reconnect after a crash), short enough that a genuinely dead server still
 * reports an error quickly.
 */
const CODEX_READY_WAIT_MS = 20_000;

export interface StartOptions {
	port?: number;
	host?: string;
	cwd?: string;
	codexPort?: number;
	codexBin?: string;
	/** 静默内部日志（测试用）。 */
	quiet?: boolean;
}

export interface ServerHandle {
	port: number;
	host: string;
	url: string;
	cwd: string;
	version: string;
	supervisor: CodexSupervisor;
	client: CodexClient;
	close(): Promise<void>;
}

interface AliveSocket extends WebSocket {
	__alive?: boolean;
}

/* ------------------------------------------------------------------ */
/* package metadata                                                    */
/* ------------------------------------------------------------------ */

/** 从当前文件向上找 package.json —— 兼容 tsx(src) 与 dist 两种目录深度。 */
function findPackageRoot(startDir: string): string {
	let dir = startDir;
	for (let i = 0; i < 8; i += 1) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return startDir;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = findPackageRoot(__dirname);

function readOwnVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function codexVersionFromHandshake(userAgent: string | undefined): string | null {
	if (!userAgent) return null;
	// 形如 `codex-cli 0.156.1` 或 `codex/0.156.1 ...`。
	const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(userAgent);
	return match ? match[1] : userAgent;
}

/* ------------------------------------------------------------------ */
/* origin admission                                                    */
/* ------------------------------------------------------------------ */

function parseAllowOrigins(): string[] {
	return (process.env.CW_ALLOW_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * 浏览器 upgrade 的 Origin 校验：
 *  - 无 Origin（curl / 脚本 / ws 测试）放行；
 *  - 设置了 CW_ALLOW_ORIGINS 就按白名单；
 *  - 否则放行同源，以及 localhost / 127.0.0.1 / ::1 的任意端口（覆盖 Vite dev server）。
 */
function originAllowed(req: { headers: Record<string, string | string[] | undefined> }): boolean {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || !origin) return true;
	const lower = origin.toLowerCase();
	const allow = parseAllowOrigins();
	if (allow.length > 0) return allow.includes(lower);
	if (lower === "null") return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const hostHeader = req.headers.host;
	if (typeof hostHeader === "string" && hostHeader) {
		try {
			const hostUrl = new URL(`http://${hostHeader}`);
			if (url.hostname === hostUrl.hostname && url.port === hostUrl.port) return true;
		} catch {
			/* ignore */
		}
	}
	const hn = url.hostname.toLowerCase();
	return hn === "localhost" || hn === "127.0.0.1" || hn === "::1" || hn === "[::1]";
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asJsonRpcError(err: unknown): JsonRpcError {
	if (err instanceof FsError) return { code: err.code, message: err.message };
	if (isRecord(err)) {
		return {
			code: typeof err.code === "number" ? err.code : -32000,
			message: typeof err.message === "string" ? err.message : "internal error",
			data: err.data,
		};
	}
	return { code: -32000, message: err instanceof Error ? err.message : String(err) };
}

/* ------------------------------------------------------------------ */
/* startServer                                                         */
/* ------------------------------------------------------------------ */

export async function startServer(options: StartOptions = {}): Promise<ServerHandle> {
	const version = readOwnVersion();
	const cwd = resolve(options.cwd ?? process.env.CW_CWD ?? process.cwd());
	const port = options.port ?? Number(process.env.CW_PORT ?? DEFAULT_CW_PORT);
	const host = options.host ?? process.env.CW_HOST ?? DEFAULT_CW_HOST;
	const codexPort = options.codexPort ?? Number(process.env.CW_CODEX_PORT ?? DEFAULT_CODEX_PORT);
	const codexBin = options.codexBin ?? process.env.CW_CODEX_BIN ?? DEFAULT_CODEX_BIN;
	const log = options.quiet
		? (): void => undefined
		: (...args: unknown[]): void => {
				console.log("[open-web-app]", ...args);
			};

	/* -------- supervisor + client (capture/inspector off by default) -------- */
	// 抓包（loopback Responses 代理）默认关闭：只有显式设置 CW_REQUEST_INSPECTOR=1
	// 才会启动 inspector，也才会给 app-server 注入 chatgpt_base_url /
	// model_providers.capture.base_url 这两个 -c 覆盖。默认一个都不加，codex 走自己的配置。
	const inspector = new RequestInspector({ dataDir: join(PACKAGE_ROOT, "data") });
	let inspectorUrl = "";
	if (process.env.CW_REQUEST_INSPECTOR === "1") {
		try {
			inspectorUrl = await inspector.start();
			log(`request inspector: ${inspectorUrl} -> ${process.env.CW_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex"}`);
		} catch (error) {
			log(`request inspector disabled: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const supervisor = new CodexSupervisor({ port: codexPort, bin: codexBin, cwd, codexBaseUrl: inspectorUrl || undefined });
	const client = new CodexClient(supervisor.url, version);

	supervisor.onLog((line) => {
		if (!options.quiet) console.log("[codex]", line);
	});

	await supervisor.start();
	void client.connect();

	/* -------- HTTP app -------- */
	const app = express();
	app.disable("x-powered-by");

	app.get("/api/health", (_req: Request, res: Response) => {
		const body = { ok: true as const, codex: supervisor.status(), version };
		res.json(body);
	});

	app.get("/api/version", (_req: Request, res: Response) => {
		const hs = client.handshake();
		res.json({
			name: "open-web-app",
			version,
			protocolVersion: PROTOCOL_VERSION,
			codexVersion: codexVersionFromHandshake(hs?.userAgent),
			codexUserAgent: hs?.userAgent ?? null,
			codexUrl: supervisor.url,
		});
	});

	// 生产：静态前端 + SPA fallback。import 时不要求 web/dist 存在（dev 由 Vite 提供）。
	const webDist = join(PACKAGE_ROOT, "web", "dist");
	if (existsSync(webDist)) {
		app.use(express.static(webDist));
		app.get(/^\/(?!api\/|ws).*/, (_req: Request, res: Response) => {
			res.sendFile(join(webDist, "index.html"));
		});
		log(`serving web UI from ${webDist}`);
	} else {
		log(`web/dist not found (dev mode?) — 构建前端后刷新: npm run build:web`);
		app.get(/^\/(?!api\/|ws).*/, (_req: Request, res: Response) => {
			res.status(404).type("text/plain").send("web/dist 不存在。开发模式请访问 Vite dev server (:5174)；生产请先 npm run build。");
		});
	}

	const httpServer: HttpServer = createServer(app);

	/* -------- WebSocket hub -------- */
	const wss = new WebSocketServer({ noServer: true });
	const browsers = new Set<AliveSocket>();

	const send = (ws: WebSocket, msg: ServerMessage): void => {
		if (ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* ignore */
		}
	};

	const broadcast = (msg: ServerMessage): void => {
		for (const ws of browsers) send(ws, msg);
	};

	const broadcastStatus = (): void => {
		broadcast({ type: "status", codex: supervisor.status() });
	};

	let prevPhase = supervisor.status().phase;
	supervisor.onStatus((status) => {
		broadcastStatus();
		// supervisor 重新就绪后主动拉一次 codex 连接，避免等满 client 自己的退避。
		if (status.phase === "ready" && prevPhase !== "ready" && !client.isReady()) client.reconnect();
		prevPhase = status.phase;
	});

	client.on("state", (state: { connected: boolean; error: string | null; since: number | null }) => {
		supervisor.setConnected(state.connected, state.error);
	});

	client.on("notification", (evt: { method: string; params: unknown }) => {
		broadcast({ type: "event", method: evt.method, params: evt.params });
	});

	// codex 反向请求：广播给所有浏览器，记录待答复集合用于去重。
	const pendingServerRequests = new Map<string, { method: string; threadId: string | null }>();
	const answeredServerRequests = new Set<string>();
	client.on("serverRequest", (evt: { id: RequestId; method: string; params: unknown }) => {
		const key = String(evt.id);
		const threadId = isRecord(evt.params) && typeof evt.params.threadId === "string" ? evt.params.threadId : null;
		pendingServerRequests.set(key, { method: evt.method, threadId });
		broadcast({ type: "serverRequest", id: evt.id, method: evt.method, params: evt.params });
	});

	client.on("state", (state: { connected: boolean }) => {
		// 断线后 codex 可能复用 request id，清掉去重历史避免误吞新请求。
		if (!state.connected) {
			pendingServerRequests.clear();
			answeredServerRequests.clear();
		}
	});

	function rememberAnswered(key: string): void {
		answeredServerRequests.add(key);
		if (answeredServerRequests.size > SERVER_REQUEST_HISTORY) {
			const first = answeredServerRequests.values().next().value;
			if (first !== undefined) answeredServerRequests.delete(first);
		}
	}

	/* -------- local `cw/*` methods -------- */
	async function handleLocal(method: string, params: unknown): Promise<unknown> {
		const p = isRecord(params) ? params : {};
		switch (method) {
			case LOCAL_METHODS.codexStatus:
				return { status: supervisor.status() };
			case LOCAL_METHODS.codexRestart:
				await supervisor.restart();
				client.reconnect();
				return { ok: true };
			case LOCAL_METHODS.codexLog:
				return { lines: supervisor.logLines() };
			case LOCAL_METHODS.requestLogsList:
				return inspector.list(typeof p.threadId === "string" ? p.threadId : undefined, typeof p.limit === "number" ? p.limit : undefined);
			case LOCAL_METHODS.requestLogsDetail: {
				if (typeof p.id !== "string" || !p.id) throw new FsError(-32602, "cw/request-logs/detail requires { id: string }");
				const entry = await inspector.get(p.id);
				if (!entry) throw new FsError(-32004, "request log not found");
				return entry;
			}
			case LOCAL_METHODS.fsList:
				return listDirectory({
					path: typeof p.path === "string" ? p.path : undefined,
					cwd,
					maxEntries: typeof p.maxEntries === "number" ? p.maxEntries : undefined,
				});
			case LOCAL_METHODS.fsRead:
				if (typeof p.path !== "string") throw new FsError(-32602, "cw/fs/read requires { path: string }");
				return readTextFile({
					path: p.path,
					cwd,
					maxBytes: typeof p.maxBytes === "number" ? p.maxBytes : undefined,
				});
			case LOCAL_METHODS.paths: {
				const codexHome = client.handshake()?.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
				return resolvePaths(cwd, codexHome);
			}
			default:
				throw { code: -32601, message: `unknown local method: ${method}` };
		}
	}

	/* -------- browser message handling -------- */
	async function handleRpc(ws: WebSocket, requestId: string, method: string, params: unknown): Promise<void> {
		try {
			let result: unknown;
			if (method.startsWith("cw/")) {
				result = await handleLocal(method, params);
			} else {
				// A browser opened during startup races the app-server's boot (and a
				// reconnect after a codex crash). Wait briefly instead of failing the
				// client's first requests; only report -32001 if it never comes up.
				if (!client.isReady() && !(await client.waitUntilReady(CODEX_READY_WAIT_MS))) {
					throw { code: -32001, message: "codex app-server not connected" };
				}
				result = await client.request(method, params);
			}
			send(ws, { type: "rpcResult", requestId, ok: true, result });
		} catch (err) {
			send(ws, { type: "rpcResult", requestId, ok: false, error: asJsonRpcError(err) });
		}
	}

	function handleReply(id: RequestId, result: unknown, error: JsonRpcError | undefined): void {
		const key = String(id);
		if (answeredServerRequests.has(key)) return; // 其他标签页已答复，忽略后来者
		rememberAnswered(key);
		const pending = pendingServerRequests.get(key);
		pendingServerRequests.delete(key);
		if (error) client.respondError(id, error);
		else client.respond(id, result);
		// 让其他标签页关闭审批弹窗；复用 codex 自己的通知名。
		broadcast({
			type: "event",
			method: "serverRequest/resolved",
			params: { threadId: pending?.threadId ?? null, requestId: id },
		});
	}

	async function onBrowserMessage(ws: WebSocket, raw: RawData): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
		} catch {
			log("忽略非 JSON 的浏览器报文");
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") return;
		const msg = parsed as unknown as ClientMessage;

		switch (msg.type) {
			case "rpc": {
				if (typeof msg.requestId !== "string" || typeof msg.method !== "string") return;
				await handleRpc(ws, msg.requestId, msg.method, msg.params);
				return;
			}
			case "reply": {
				if (msg.id === undefined || msg.id === null) return;
				const hasError = "error" in msg && msg.error !== undefined;
				const error = hasError ? asJsonRpcError((msg as { error: unknown }).error) : undefined;
				handleReply(msg.id, (msg as { result?: unknown }).result, error);
				return;
			}
			case "ping":
				send(ws, { type: "pong" });
				return;
			default:
				return;
		}
	}

	wss.on("connection", (ws: AliveSocket) => {
		ws.__alive = true;
		browsers.add(ws);
		ws.on("pong", () => {
			ws.__alive = true;
		});
		ws.on("message", (raw) => {
			void onBrowserMessage(ws, raw).catch((err) => log("browser message handler error:", err));
		});
		ws.on("error", (err) => log("browser socket error:", err.message));
		ws.on("close", () => browsers.delete(ws));

		const info: ServerInfo = {
			version,
			protocolVersion: PROTOCOL_VERSION,
			cwd,
			codexUrl: supervisor.url,
			codexVersion: codexVersionFromHandshake(client.handshake()?.userAgent),
			platform: process.platform,
		};
		send(ws, { type: "welcome", info });
		send(ws, { type: "status", codex: supervisor.status() });
	});

	// 升级前做 origin 校验 + 路径校验；非 /ws 直接 destroy。
	httpServer.on("upgrade", (req, socket, head) => {
		let pathname = "/";
		try {
			pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		} catch {
			/* fall through */
		}
		if (pathname !== "/ws") {
			socket.destroy();
			return;
		}
		if (!originAllowed(req)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	});

	// 心跳：30s 一次 ping，未回 pong 的直接 terminate。
	const heartbeat = setInterval(() => {
		for (const ws of browsers) {
			if (ws.__alive === false) {
				ws.terminate();
				browsers.delete(ws);
				continue;
			}
			ws.__alive = false;
			try {
				ws.ping();
			} catch {
				/* ignore */
			}
		}
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	/* -------- listen -------- */
	await new Promise<void>((resolvePromise, rejectPromise) => {
		httpServer.once("error", rejectPromise);
		httpServer.listen(port, host, () => resolvePromise());
	});
	const address = httpServer.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	const url = `http://${host}:${actualPort}`;
	log(`listening on ${url} (ws://${host}:${actualPort}/ws)`);
	log(`codex app-server: ${supervisor.url} (${supervisor.isExternal() ? "external" : "managed"})`);

	/* -------- close -------- */
	let closed = false;
	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		for (const ws of browsers) {
			try {
				ws.close(1001, "server shutting down");
			} catch {
				/* ignore */
			}
			ws.terminate();
		}
		browsers.clear();
		client.close();
		await supervisor.stop();
		await inspector.close();
		await new Promise<void>((resolvePromise) => {
			wss.close(() => resolvePromise());
			// 没有活跃连接时 wss.close 回调可能不触发；兜底。
			setTimeout(resolvePromise, 500);
		});
		await new Promise<void>((resolvePromise) => {
			httpServer.close(() => resolvePromise());
			setTimeout(resolvePromise, 500);
		});
	}

	return { port: actualPort, host, url, cwd, version, supervisor, client, close };
}

/* ------------------------------------------------------------------ */
/* direct execution (node dist/server/index.js)                        */
/* ------------------------------------------------------------------ */

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
	startServer()
		.then((handle) => {
			const shutdown = (signal: string): void => {
				console.log(`\n[open-web-app] received ${signal}, shutting down…`);
				void handle.close().finally(() => process.exit(0));
			};
			process.on("SIGINT", () => shutdown("SIGINT"));
			process.on("SIGTERM", () => shutdown("SIGTERM"));
		})
		.catch((err) => {
			console.error("[open-web-app] failed to start:", err);
			process.exit(1);
		});
}
