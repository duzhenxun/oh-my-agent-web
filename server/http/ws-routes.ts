/**
 * 推送通道的 WebSocket 版（ADR-0032 修订）：**浏览器连接池的解药**。
 *
 * 为什么要有它：Chrome 对同一个 `host:port` 只给 **6 条** HTTP/1.1 连接，而 SSE 是长连接 ——
 * 每个标签页 1 条、每个终端 1 条、每个临时聊天 1 条，全都长期占着名额。占满 6 条之后
 * **一次普通的页面加载都发不出去**：DevTools 里停在 `Provisional headers are shown`，
 * 整个应用看着像卡死（用户 2026-11-04 反复撞到，已复现）。
 *
 * WebSocket **不占这 6 条**（Chrome 对 WS 的限制是每 host 255 条），所以把这些「永远不结束」
 * 的流搬过来，HTTP 池就只剩「加载页面 / 一次 RPC」这种短请求，再也不会被占死。
 *
 * 三条通道（都用同一个端点，靠查询参数区分）：
 *   - `?client=<id>&slim=1`  主事件流（快照 / 事件）：与 `/api/events` 完全同一份 sink；
 *   - `?client=<id>`         临时聊天（它自己一个 client id，同一份 sink 机制）；
 *   - `?terminal=<id>`       终端输出（服务端 PTY 的字节流）。
 *
 * 帧格式：**和 SSE 的 `data:` 里那串字节一模一样**（主通道是一包 ServerMessage JSON，
 * 终端是一段输出字符串的 JSON）。这样前端两种传输共用一套解析，不用分叉。
 *
 * 与 SSE 的关系：`/api/events`、`/api/terminal/stream` **保留**（老标签页、代理挡掉 Upgrade
 * 的环境还能退回 SSE，见 `web/src/stream.ts` 的兜底）。两条路写的是同一份 `sinks` / 监听器表。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Snapshot } from "../protocol.js";
import type { Sink } from "./live-routes.js";

/** 心跳间隔：中间代理一般 60s 掐空闲连接，25s 一次 ping 足够保活 */
const BEAT_MS = 25_000;

export function registerWebSocketRoutes(
	server: Server,
	options: {
		/** clientId → 写入函数（与 SSE 共用） */
		sinks: Map<string, Sink>;
		snapshotFor: (clientId: string) => Snapshot;
		clientTracker?: { setSlim: (clientId: string, slim: boolean) => void; drop: (clientId: string) => void };
		/**
		 * 订阅某个终端的输出。终端不存在时回 null（不能让连接挂着一条永远不会来数据的流）。
		 * 返回取消订阅函数。
		 */
		watchTerminal: (id: string, listener: (chunk: string) => void) => (() => void) | null;
		/** 握手鉴权：与 HTTP 面**同一套**判断（本机放行 / 远程要密码 / 同源门禁） */
		authorize: (request: IncomingMessage) => boolean;
		logger: {
			debug: (message: string, meta?: Record<string, unknown>) => void;
			warn: (message: string, meta?: Record<string, unknown>) => void;
		};
	},
): void {
	/**
	 * `perMessageDeflate`：快照一帧几百 KB（长对话 2MB），SSE 时代是靠 gzip 压的；
	 * WS 默认**不压**，不显式打开的话流量会翻好几倍（手机上尤其明显）。
	 * 阈值 1KB：终端那种几十字节的高频小帧不值得压。
	 */
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
		perMessageDeflate: { threshold: 1024 },
	});

	server.on("upgrade", (request, socket, head) => {
		let path = "";
		let query = new URLSearchParams();
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			path = url.pathname;
			query = url.searchParams;
		} catch {
			socket.destroy();
			return;
		}
		// 只有这一个端点走 WS：别的路径（比如别人扫过来的 Upgrade）直接掐掉
		if (path !== "/ws") {
			socket.destroy();
			return;
		}
		if (!options.authorize(request)) {
			// 101 之前拒：给一个明确的 403，前端据此退回 SSE（那里有 cookie 登录页那一套）
			socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, request, query));
	});

	function handleConnection(ws: WebSocket, request: IncomingMessage, query: URLSearchParams): void {
		const terminalId = query.get("terminal");
		if (terminalId !== null && terminalId !== "") {
			connectTerminal(ws, terminalId);
			return;
		}
		connectEvents(ws, request, query);
	}

	/** 终端通道：把 PTY 的输出原样推过去（与 SSE 里 `data: JSON.stringify(chunk)` 同格式） */
	function connectTerminal(ws: WebSocket, id: string): void {
		const off = options.watchTerminal(id, (chunk) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(chunk));
		});
		if (!off) {
			// 终端还没起来 / 已经被关掉：1008 让前端知道别再重连这条
			ws.close(1008, "terminal not found");
			return;
		}
		const beat = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		}, BEAT_MS);
		const cleanup = () => {
			clearInterval(beat);
			off();
		};
		ws.on("close", cleanup);
		ws.on("error", cleanup);
	}

	/** 事件通道：与 SSE 那条路共用 `sinks`，snapshot / 事件帧一个字都不用变 */
	function connectEvents(ws: WebSocket, request: IncomingMessage, query: URLSearchParams): void {
		const clientId = query.get("client") ?? cookieClientId(request) ?? randomUUID();
		const sink: Sink = (payload) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(payload);
		};
		// 同一个 clientId 重连（刷新 / 切回前台）时直接覆盖：旧连接即便还没关，
		// 它的 close 回调会发现 map 里已经不是自己，不会把新连接一起清掉
		options.sinks.set(clientId, sink);
		// 能力协商：`slim=1` = 快照里可以省掉会话清单（变了再发）
		options.clientTracker?.setSlim(clientId, query.get("slim") === "1");
		options.logger.debug("WS 已连接", { clients: options.sinks.size, client: clientId.slice(0, 8) });

		// 首帧：这个客户端自己那份快照（会话、草稿、队列都按它来）
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: options.snapshotFor(clientId) }));

		const beat = setInterval(() => {
			// ping 兼做「对端还在不在」的探测：浏览器自动回 pong
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		}, BEAT_MS);

		ws.on("close", () => {
			clearInterval(beat);
			// 只删**自己**那条（同 clientId 的新连接会覆盖 map 里的条目）
			if (options.sinks.get(clientId) === sink) {
				options.sinks.delete(clientId);
				options.clientTracker?.drop(clientId);
			}
			options.logger.debug("WS 已断开", { clients: options.sinks.size });
		});
		ws.on("error", (error) => {
			options.logger.warn("WS 连接出错", { message: error instanceof Error ? error.message : String(error) });
			ws.close();
		});
	}

	/** 兜底：客户端没带 `?client=`（老代码 / 手写客户端）时，沿用 HTTP 面发的那份 cookie */
	function cookieClientId(request: IncomingMessage): string | null {
		const header = request.headers.cookie;
		if (!header) return null;
		for (const part of header.split(";")) {
			const [name, ...rest] = part.trim().split("=");
			if (name === "agent-web-client") {
				const value = rest.join("=").trim();
				return value === "" ? null : value;
			}
		}
		return null;
	}
}
