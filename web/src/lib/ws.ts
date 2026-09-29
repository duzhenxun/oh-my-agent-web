// Transport for the browser <-> open-web-app server WebSocket.
//
// Responsibilities:
//   * connect + auto-reconnect with exponential backoff + jitter
//   * turn `rpc` calls into promises with a timeout
//   * fan out `welcome` / `status` / `event` / `serverRequest` / `pong`
//   * heartbeat pings so dead connections are detected promptly
//
// It is intentionally framework-free; React binds to it in state/CodexProvider.

import type {
	ClientMessage,
	CodexStatus,
	RequestId,
	ServerInfo,
	ServerMessage,
} from "@shared/protocol";
import { errorMessage, isRecord } from "./codex-types";

export type ConnectionState = "connecting" | "open" | "closed";

export interface CloseInfo {
	code: number;
	reason: string;
	willReconnect: boolean;
}

export interface CodexSocketHandlers {
	onState?: (state: ConnectionState) => void;
	onOpen?: () => void;
	onClose?: (info: CloseInfo) => void;
	onWelcome?: (info: ServerInfo) => void;
	onStatus?: (status: CodexStatus) => void;
	onEvent?: (method: string, params: unknown) => void;
	onServerRequest?: (id: RequestId, method: string, params: unknown) => void;
	onProtocolError?: (message: string) => void;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface RpcOptions {
	timeoutMs?: number;
}

const HEARTBEAT_MS = 15_000;
const STALE_MS = 40_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export function defaultWsUrl(): string {
	if (typeof window === "undefined") return "ws://127.0.0.1:25257/ws";
	const params = new URLSearchParams(window.location.search);
	const override = params.get("ws");
	if (override) return override;
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${window.location.host}/ws`;
}

export class CodexSocket {
	private ws: WebSocket | null = null;
	private handlers: CodexSocketHandlers = {};
	private pending = new Map<string, PendingCall>();
	private seq = 0;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastMessageAt = 0;
	private disposed = false;
	private state: ConnectionState = "closed";
	private url: string;

	constructor(url: string = defaultWsUrl()) {
		this.url = url;
	}

	setHandlers(handlers: CodexSocketHandlers): void {
		this.handlers = handlers;
	}

	getState(): ConnectionState {
		return this.state;
	}

	private setState(next: ConnectionState): void {
		if (this.state === next) return;
		this.state = next;
		this.handlers.onState?.(next);
	}

	connect(): void {
		if (this.disposed) return;
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			return;
		}
		this.clearReconnect();
		this.setState("connecting");
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.url);
		} catch (err) {
			this.handlers.onProtocolError?.(`Could not open WebSocket: ${errorMessage(err)}`);
			this.scheduleReconnect();
			return;
		}
		this.ws = socket;

		socket.onopen = () => {
			if (this.ws !== socket) return;
			this.attempt = 0;
			this.lastMessageAt = Date.now();
			this.setState("open");
			this.handlers.onOpen?.();
			this.startHeartbeat();
		};
		socket.onmessage = (ev: MessageEvent) => {
			if (this.ws !== socket) return;
			this.lastMessageAt = Date.now();
			this.handleMessage(ev.data);
		};
		socket.onerror = () => {
			// The close handler drives reconnection; errors here are noisy.
		};
		socket.onclose = (ev: CloseEvent) => {
			if (this.ws !== socket) return;
			this.ws = null;
			this.stopHeartbeat();
			this.setState("closed");
			this.rejectAll(new Error("Connection closed"));
			const willReconnect = !this.disposed;
			this.handlers.onClose?.({ code: ev.code, reason: ev.reason, willReconnect });
			if (willReconnect) this.scheduleReconnect();
		};
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== "string") {
			// We only speak JSON text frames.
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.handlers.onProtocolError?.("Received malformed JSON from server");
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			this.handlers.onProtocolError?.("Received message without a type");
			return;
		}
		const msg = parsed as unknown as ServerMessage;
		switch (msg.type) {
			case "welcome":
				if (isRecord(msg.info)) this.handlers.onWelcome?.(msg.info as unknown as ServerInfo);
				break;
			case "status":
				if (isRecord(msg.codex)) this.handlers.onStatus?.(msg.codex as unknown as CodexStatus);
				break;
			case "rpcResult": {
				const call = this.pending.get(msg.requestId);
				if (!call) break;
				this.pending.delete(msg.requestId);
				clearTimeout(call.timer);
				if (msg.ok) call.resolve(msg.result);
				else call.reject(new RpcError(msg.error?.message ?? "RPC failed", msg.error));
				break;
			}
			case "event":
				if (typeof msg.method === "string") this.handlers.onEvent?.(msg.method, msg.params);
				break;
			case "serverRequest":
				this.handlers.onServerRequest?.(msg.id, msg.method, msg.params);
				break;
			case "pong":
				break;
			default:
				break;
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (Date.now() - this.lastMessageAt > STALE_MS) {
				// No traffic for a while: force a reconnect.
				try {
					this.ws?.close(4000, "heartbeat timeout");
				} catch {
					/* ignore */
				}
				return;
			}
			this.sendRaw({ type: "ping" });
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer) return;
		const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
		const jitter = Math.random() * 0.3 * backoff;
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, backoff + jitter);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private sendRaw(message: ClientMessage): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		try {
			this.ws.send(JSON.stringify(message));
			return true;
		} catch (err) {
			this.handlers.onProtocolError?.(`Failed to send: ${errorMessage(err)}`);
			return false;
		}
	}

	/** Invoke a codex method (or `cw/*`). Rejects on timeout, close, or RPC error. */
	rpc<T = unknown>(method: string, params?: unknown, options: RpcOptions = {}): Promise<T> {
		const requestId = `r${++this.seq}`;
		const timeoutMs = options.timeoutMs ?? 60_000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`RPC "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
			const ok = this.sendRaw({ type: "rpc", requestId, method, params });
			if (!ok) {
				clearTimeout(timer);
				this.pending.delete(requestId);
				reject(new Error(`WebSocket is not connected (rpc "${method}")`));
			}
		});
	}

	reply(id: RequestId, result: unknown): void {
		this.sendRaw({ type: "reply", id, result });
	}

	replyError(id: RequestId, error: { code: number; message: string; data?: unknown }): void {
		this.sendRaw({ type: "reply", id, error });
	}

	dispose(): void {
		this.disposed = true;
		this.clearReconnect();
		this.stopHeartbeat();
		this.rejectAll(new Error("Socket disposed"));
		try {
			this.ws?.close(1000, "client disposed");
		} catch {
			/* ignore */
		}
		this.ws = null;
	}

	private rejectAll(error: Error): void {
		for (const [, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(error);
		}
		this.pending.clear();
	}
}

export class RpcError extends Error {
	code: number | undefined;
	data: unknown;
	constructor(message: string, error?: { code?: number; data?: unknown }) {
		super(message);
		this.name = "RpcError";
		this.code = error?.code;
		this.data = error?.data;
	}
}
