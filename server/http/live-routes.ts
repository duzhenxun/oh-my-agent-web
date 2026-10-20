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

		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// nginx 默认会缓冲响应体，SSE 必须显式关掉，否则事件全卡在缓冲里
			"x-accel-buffering": "no",
		});
		response.flushHeaders?.();

		const sink: Sink = (payload) => response.write(`data: ${payload}\n\n`);
		deps.sinks.set(clientId, sink);
		deps.logger.info("SSE 已连接", { clients: deps.sinks.size });

		// 首屏：立刻给这个客户端一份「属于它自己」的快照
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: deps.snapshotFor(clientId) }));

		// 心跳：中间代理一般 60s 掐空闲连接，25s 发一次注释行足够保活
		const beat = setInterval(() => response.write(": ping\n\n"), 25_000);

		request.on("close", () => {
			clearInterval(beat);
			deps.sinks.delete(clientId);
			deps.logger.info("SSE 已断开", { clients: deps.sinks.size });
		});
	});

	app.post("/api/rpc", async (request, response) => {
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
