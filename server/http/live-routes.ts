/**
 * 纯 HTTP 的实时通道（SSE + RPC），用来替代 WebSocket。
 *
 * 为什么要有这条路：WS 要 `Upgrade` 头、自己的 Origin/Host 白名单、还有 Basic 凭据在
 * 握手阶段的种种坑（反代、域名、https 终结都容易踩）。HTTP 没这些麻烦 ——
 * 只要代理能转发普通请求，它就能用。
 *
 * 两个端点：
 *   - `GET  /api/events`  SSE 长连接：服务端 → 客户端（快照 / 事件）
 *   - `POST /api/rpc`     一问一答：客户端 → 服务端（协议不变，还是 ClientRequest）
 *
 * 协议本身**一处没改**：SSE 的每条 data 就是一个原本要通过 WS 发出去的 JSON 帧。
 */
import type { Express } from "express";
import type { Snapshot } from "../protocol.js";

/** 往一个 SSE 连接里写一帧 */
export type Sink = (payload: string) => void;

export type LiveDeps = {
	sinks: Set<Sink>;
	/** 与 WS 那条路复用同一个分发器（handleMessage） */
	handleMessage: (socket: { send: (payload: string) => void }, raw: string) => Promise<void>;
	snapshot: () => Snapshot;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
};

export function registerLiveRoutes(app: Express, deps: LiveDeps): void {
	app.get("/api/events", (request, response) => {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// nginx 默认会缓冲响应体，SSE 必须显式关掉，否则「事件全都卡在缓冲里」
			"x-accel-buffering": "no",
		});
		response.flushHeaders?.();

		const sink: Sink = (payload) => response.write(`data: ${payload}\n\n`);
		deps.sinks.add(sink);
		deps.logger.info("SSE 已连接", { clients: deps.sinks.size });

		// 首屏：立刻给一份快照，不等节流窗口
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: deps.snapshot() }));

		// 心跳：中间代理一般 60s 掐空闲连接，25s 发一次注释行足够保活
		const beat = setInterval(() => response.write(": ping\n\n"), 25_000);

		request.on("close", () => {
			clearInterval(beat);
			deps.sinks.delete(sink);
			deps.logger.info("SSE 已断开", { clients: deps.sinks.size });
		});
	});

	app.post("/api/rpc", async (request, response) => {
		const frames: string[] = [];
		const shim = { send: (payload: string) => frames.push(payload) };
		try {
			await deps.handleMessage(shim, JSON.stringify(request.body));
		} catch (error) {
			deps.logger.info("RPC 处理失败", { message: error instanceof Error ? error.message : String(error) });
			response.status(500).json({ frames, error: "handler_failed" });
			return;
		}
		// 处理过程中同步产生的帧（reply / notice）一并带回；异步事件走 SSE
		response.json({ frames });
	});
}
