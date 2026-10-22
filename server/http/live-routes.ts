/**
 * 纯 HTTP 的实时通道（SSE + RPC）。ADR-0032 定通道，ADR-0033 定「每客户端一份会话视图」。
 *
 * 两个端点：
 *   - `GET  /api/events`   SSE 长连接：服务端 → 客户端（快照 / 事件）
 *   - `POST /api/rpc`      一问一答：客户端 → 服务端（协议不变，还是 ClientRequest）
 *
 * 客户端身份：`agent-web-client` cookie。有了它，快照才能按「这个客户端在看哪个会话」生成
 * （否则两个标签页会互相拽着切换）。cookie 不存在时由 `/api/events` 发一个。
 */
import { randomUUID } from "node:crypto";
import { constants as zlibConstants, createGzip } from "node:zlib";
import type { Express } from "express";
import type { Snapshot } from "../protocol.js";

export const CLIENT_COOKIE = "agent-web-client";
/** 每个标签页自己的标识（cookie 是同浏览器共享的，不能用来区分标签页） */
export const CLIENT_HEADER = "x-agent-client";

export type Sink = (payload: string) => void;

export type LiveDeps = {
	/** clientId → 这条 SSE 连接的写入函数 */
	sinks: Map<string, Sink>;
	/** 按客户端生成快照（active 用它自己选中的会话） */
	snapshotFor: (clientId: string) => Snapshot;
	/**
	 * 客户端生命周期：`slim` 是能力协商（`?slim=1` = 受得了快照里省掉会话清单），
	 * `drop` 在 SSE 断开时清掉这个客户端的记录。
	 */
	clientTracker?: {
		setSlim: (clientId: string, slim: boolean) => void;
		drop: (clientId: string) => void;
	};
	/** 请求分发（与 WS 那条路共用） */
	handleMessage: (clientId: string, socket: { send: (payload: string) => void }, raw: string) => Promise<void>;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
};

/** 客户端标识：优先请求头 / 查询参数（每个标签页不一样），最后才回落到 cookie */
export function clientIdOf(input: {
	header?: string | string[] | undefined;
	query?: unknown;
	cookie?: string | undefined;
}): string | null {
	const fromHeader = Array.isArray(input.header) ? input.header[0] : input.header;
	if (typeof fromHeader === "string" && fromHeader.trim() !== "") return fromHeader.trim();
	if (typeof input.query === "string" && input.query.trim() !== "") return input.query.trim();
	return clientIdFromCookie(input.cookie);
}

/** 从 Cookie 头里取客户端标识 */
export function clientIdFromCookie(header: string | undefined): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === CLIENT_COOKIE) {
			const value = rest.join("=").trim();
			return value === "" ? null : value;
		}
	}
	return null;
}

export function registerLiveRoutes(app: Express, deps: LiveDeps): void {
	app.get("/api/events", (request, response) => {
		const existing = clientIdOf({
			header: request.headers[CLIENT_HEADER],
			query: request.query?.client,
			cookie: request.headers.cookie,
		});
		const clientId = existing ?? randomUUID();
		if (!existing) {
			response.setHeader(
				"Set-Cookie",
				`${CLIENT_COOKIE}=${clientId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
			);
		}

		// SSE 首帧快照 ~136KB，wifi/外网下很慢；能 gzip 就流式压（不能攒，必须边压边发）
		const gzip = /gzip/i.test(String(request.headers["accept-encoding"] ?? ""));
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			// no-store：**不能让任何代理/缓存重放这条响应**。曾经怀疑过反向代理把
			// 首个客户端的 `Set-Cookie` 或首帧快照缓存后重放给别人（那会让两个设备拿到同一个
			// 客户端标识 → 互相拽着切会话）。no-transform 顺带禁掉压缩二次加工。
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			// nginx 默认会缓冲响应体，SSE 必须显式关掉，否则事件全卡在缓冲里
			"x-accel-buffering": "no",
			...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
		});
		response.flushHeaders?.();

		// `flush: Z_SYNC_FLUSH` 是必需的，不是调优项：SSE 每一帧都得**立刻**落地。
		// 默认模式（Z_NO_FLUSH）下 zlib 会把小帧攒在内部缓冲区里，几 KB～几十 KB 的快照
		// 要等下一大块数据才被推出去 —— 表现就是「切会话 / 新建会话页面不跳、快照像停了」。
		const compressor = gzip ? createGzip({ level: 6, flush: zlibConstants.Z_SYNC_FLUSH }) : null;
		compressor?.on("data", (chunk: Buffer) => response.write(chunk));
		const send = (text: string) => (compressor ? compressor.write(text) : response.write(text));
		const sink: Sink = (payload) => send(`data: ${payload}\n\n`);
		deps.sinks.set(clientId, sink);
		// 能力协商：带 slim=1 的客户端由服务端决定「会话清单只在变化时带」
		deps.clientTracker?.setSlim(clientId, request.query?.slim === "1");
		// 带上客户端标识前缀：排查「两个设备互相拽着切会话」时，一眼能看出它们是不是同一个 id
		deps.logger.info("SSE 已连接", {
			clients: deps.sinks.size,
			slim: request.query?.slim === "1",
			client: clientId.slice(0, 8),
			from: existing ? (request.query?.client ? "query" : "cookie") : "new",
		});

		// 首屏：立刻给这个客户端一份「属于它自己」的快照
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: deps.snapshotFor(clientId) }));

		// 心跳：中间代理一般 60s 掐空闲连接，25s 发一次注释行足够保活
		const beat = setInterval(() => send(": ping\n\n"), 25_000);

		request.on("close", () => {
			clearInterval(beat);
			compressor?.end();
			// 只删**自己**那条：同一个 clientId 重连时，新连接会覆盖 map 里的条目，
			// 旧连接的 close 若照删不误，就会把新连接一起干掉（心跳还在、但再也收不到快照/事件）。
			if (deps.sinks.get(clientId) === sink) {
				deps.sinks.delete(clientId);
				deps.clientTracker?.drop(clientId);
			}
			deps.logger.info("SSE 已断开", { clients: deps.sinks.size });
		});
	});

	app.post("/api/rpc", async (request, response) => {
		// 同上：RPC 的结果里带快照，绝不能被缓存重放
		response.setHeader("cache-control", "no-store");
		const clientId =
			clientIdOf({ header: request.headers[CLIENT_HEADER], cookie: request.headers.cookie }) ?? "anonymous";
		const frames: string[] = [];
		const shim = { send: (payload: string) => frames.push(payload) };
		try {
			await deps.handleMessage(clientId, shim, JSON.stringify(request.body));
		} catch (error) {
			deps.logger.info("RPC 处理失败", { message: error instanceof Error ? error.message : String(error) });
			response.status(500).json({ frames, error: "handler_failed" });
			return;
		}
		// 同步产生的帧（reply / notice）随响应带回；异步事件走 SSE
		response.json({ frames });
	});
}
