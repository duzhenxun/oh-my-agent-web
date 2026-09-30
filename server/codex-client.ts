/**
 * CodexClient — WebSocket JSON-RPC client to the codex app-server.
 *
 *  - 连接后立即 `initialize`（客户端信息 + experimentalApi），记录 userAgent /
 *    codexHome / platformOs。
 *  - socket 断开 / supervisor 重启后自动重连（指数退避），每次重连都重发 initialize。
 *  - `request(method, params)` 用自增数字 id 关联响应；JSON-RPC error 以带 code 的
 *    对象 reject。
 *  - server -> client 的通知（无 id）走 `notification` 事件；带 id 的请求（审批 /
 *    user input / 动态工具调用）走 `serverRequest` 事件。
 *  - 连接状态变化走 `state` 事件（index 借此刷新并广播 `status`）。
 *
 * 注意：codex 的报文可能不带 `jsonrpc` 字段，因此我们收发都兼容有无。
 */
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import type { JsonRpcError, RequestId } from "../shared/protocol.js";

export interface CodexHandshake {
	userAgent: string;
	codexHome: string;
	platformOs: string;
}

export interface CodexClientState {
	connected: boolean;
	error: string | null;
	/** 最近一次 initialize 成功的 ms 时间戳。 */
	since: number | null;
}

export interface CodexServerRequest {
	id: RequestId;
	method: string;
	params: unknown;
}

export interface CodexNotification {
	method: string;
	params: unknown;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: JsonRpcError) => void;
	timer: NodeJS.Timeout | null;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;
const INIT_TIMEOUT_MS = 20_000;
const NOT_CONNECTED: JsonRpcError = { code: -32001, message: "codex app-server not connected" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export class CodexClient extends EventEmitter {
	readonly url: string;
	private readonly version: string;

	private ws: WebSocket | null = null;
	private connectPromise: Promise<void> | null = null;
	private manualClose = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempts = 0;

	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private handshakeData: CodexHandshake | null = null;
	private connState: CodexClientState = { connected: false, error: null, since: null };

	constructor(url: string, version: string) {
		super();
		this.url = url;
		this.version = version;
	}

	state(): CodexClientState {
		return { ...this.connState };
	}

	handshake(): CodexHandshake | null {
		return this.handshakeData;
	}

	isReady(): boolean {
		return this.connState.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Resolve once the client is ready, or after `timeoutMs` (returns `false`).
	 *
	 * The browser can attach while the app-server is still booting, and its very
	 * first requests (`model/list`, `thread/list`, …) would otherwise fail with
	 * `-32001`. Waiting here removes that startup race for every client instead of
	 * pushing the problem into each one.
	 */
	async waitUntilReady(timeoutMs: number): Promise<boolean> {
		if (this.isReady()) return true;
		// Nudge a connection along in case nothing else is driving it yet.
		void this.connect();
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | null = null;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.off("state", onState);
				resolve(ok);
			};
			const onState = (): void => {
				if (this.isReady()) finish(true);
			};
			this.on("state", onState);
			timer = setTimeout(() => finish(this.isReady()), timeoutMs);
		});
	}

	private setState(patch: Partial<CodexClientState>): void {
		this.connState = { ...this.connState, ...patch };
		this.emit("state", this.state());
	}

	/** 建立连接；已连接 / 正在连接时幂等。 */
	connect(): Promise<void> {
		if (this.isReady()) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		this.manualClose = false;
		this.connectPromise = new Promise<void>((resolve) => {
			const ws = new WebSocket(this.url);
			this.ws = ws;

			ws.on("open", () => {
				this.reconnectAttempts = 0;
				void this.sendInitialize()
					.then(() => resolve())
					.catch(() => {
						// initialize 失败：close 处理器会负责重连，这里只解除等待。
						resolve();
					});
			});

			ws.on("message", (data) => this.onMessage(data));

			ws.on("error", (err) => {
				this.setState({ connected: false, error: err instanceof Error ? err.message : String(err) });
			});

			ws.on("close", () => {
				const wasConnected = this.connState.connected;
				this.ws = null;
				this.handshakeData = null;
				this.connectPromise = null;
				this.rejectAllPending({ code: -32002, message: "codex app-server connection closed" });
				this.setState({ connected: false, error: wasConnected ? "connection closed" : this.connState.error });
				if (!this.manualClose) this.scheduleReconnect();
				resolve();
			});
		});
		return this.connectPromise;
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const exp = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect();
		}, exp);
	}

	/** 强制断开并重连（supervisor 重启后由 index 调用）。 */
	reconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectAttempts = 0;
		const ws = this.ws;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		} else {
			void this.connect();
		}
		// close 事件会触发 scheduleReconnect；这里立即再拉一次以避免等待。
		setTimeout(() => {
			if (!this.isReady()) void this.connect();
		}, 50);
	}

	close(): void {
		this.manualClose = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.rejectAllPending({ code: -32002, message: "codex client closed" });
		const ws = this.ws;
		this.ws = null;
		this.handshakeData = null;
		this.setState({ connected: false, error: null });
		if (ws) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
	}

	private async sendInitialize(): Promise<void> {
		const params = {
			clientInfo: { name: "oh-my-agent-web", title: "Oh My Agent Web", version: this.version },
			// requestAttestation 在生成类型里是必填布尔；实测 handshake 需要它。
			capabilities: { experimentalApi: true, requestAttestation: false },
		};
		const result = await this.requestInternal("initialize", params, INIT_TIMEOUT_MS);
		if (isRecord(result)) {
			this.handshakeData = {
				userAgent: typeof result.userAgent === "string" ? result.userAgent : "unknown",
				codexHome: typeof result.codexHome === "string" ? result.codexHome : "",
				platformOs: typeof result.platformOs === "string" ? result.platformOs : process.platform,
			};
		}
		this.setState({ connected: true, error: null, since: Date.now() });
	}

	private onMessage(data: unknown): void {
		let msg: unknown;
		try {
			const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
			msg = JSON.parse(text);
		} catch {
			return; // 忽略畸形报文，绝不 crash
		}
		if (!isRecord(msg)) return;

		const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
		const method = typeof msg.method === "string" ? msg.method : null;
		const hasResult = "result" in msg;
		const hasError = "error" in msg;

		// 1) 对我们请求的响应。
		if (hasId && method === null && (hasResult || hasError)) {
			const id = msg.id;
			if (typeof id === "number") this.settle(id, hasResult ? { ok: true, value: msg.result } : { ok: false, error: msg.error });
			return;
		}

		// 2) server -> client 请求（需要 reply）。
		if (method !== null && hasId) {
			const evt: CodexServerRequest = { id: msg.id as RequestId, method, params: msg.params };
			this.emit("serverRequest", evt);
			return;
		}

		// 3) 通知。
		if (method !== null) {
			const evt: CodexNotification = { method, params: msg.params };
			this.emit("notification", evt);
		}
	}

	private settle(id: number, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (outcome.ok) {
			entry.resolve(outcome.value);
			return;
		}
		entry.reject(normalizeError(outcome.error));
	}

	private rejectAllPending(error: JsonRpcError): void {
		for (const [, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	private requestInternal(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(NOT_CONNECTED);
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject({ code: -32003, message: `${method} timed out after ${timeoutMs}ms` });
						}, timeoutMs)
					: null;
			this.pending.set(id, { method, resolve, reject, timer });
			const payload: Record<string, unknown> = { method, id };
			if (params !== undefined) payload.params = params;
			try {
				ws.send(JSON.stringify(payload));
			} catch (err) {
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				reject({ code: -32002, message: err instanceof Error ? err.message : String(err) });
			}
		});
	}

	/** 透明代理用：任意 codex 方法。未连接时立即以 -32001 reject。 */
	request(method: string, params?: unknown): Promise<unknown> {
		if (!this.isReady()) return Promise.reject(NOT_CONNECTED);
		return this.requestInternal(method, params, 0);
	}

	respond(id: RequestId, result: unknown): void {
		this.send({ id, result });
	}

	respondError(id: RequestId, error: JsonRpcError): void {
		this.send({ id, error });
	}

	private send(payload: Record<string, unknown>): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			/* 忽略：连接多半已断，重连逻辑会接手 */
		}
	}
}

function normalizeError(raw: unknown): JsonRpcError {
	if (isRecord(raw)) {
		return {
			code: typeof raw.code === "number" ? raw.code : -32000,
			message: typeof raw.message === "string" ? raw.message : "codex error",
			data: raw.data,
		};
	}
	return { code: -32000, message: typeof raw === "string" ? raw : "codex error" };
}
