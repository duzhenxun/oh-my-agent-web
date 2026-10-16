/**
 * WS 客户端（ADR-0004）。
 *
 * 三件事：
 *   1. 连上就发 `get_state` 拉一份权威快照（刷新/重连后状态自动正确）；
 *   2. 快照**整体替换**本地状态（服务端是唯一事实源；乐观更新只能做视觉临时态）；
 *   3. 正文靠 `message_delta` 就地追加，避免每字一次全量。
 *
 * 断线重连：指数退避（0.5s → 8s 封顶）。服务端在断线期间继续干活（ADR-0004 §6）。
 */
import { getAppState, setAppState } from "./store.ts";
import type { ClientRequest, ClientRequestType, ServerMessage, Snapshot } from "./types.ts";
import { appendTextToMessage } from "./lib/delta.ts";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

let socket: WebSocket | null = null;
let attempt = 0;
let seq = 0;

function wsUrl(): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/ws`;
}

export function connect(): void {
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

	setAppState({ connection: "connecting" });
	const next = new WebSocket(wsUrl());
	socket = next;

	next.addEventListener("open", () => {
		attempt = 0;
		setAppState({ connection: "open", lastError: null });
		request("get_state");
	});

	next.addEventListener("message", (event) => {
		let parsed: ServerMessage;
		try {
			parsed = JSON.parse(String(event.data)) as ServerMessage;
		} catch {
			return;
		}
		handle(parsed);
	});

	next.addEventListener("close", () => {
		setAppState({ connection: "closed" });
		socket = null;
		const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
		attempt += 1;
		setTimeout(connect, delay);
	});

	next.addEventListener("error", () => {
		setAppState({ lastError: "连接出错，正在重试…" });
	});
}

export function request(type: ClientRequestType): string {
	const id = `req-${++seq}`;
	send({ id, type } as ClientRequest);
	return id;
}

export function send(requestMessage: ClientRequest): void {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		setAppState({ lastError: "连接尚未就绪，稍后再试" });
		return;
	}
	socket.send(JSON.stringify(requestMessage));
}

export function sendMessage(text: string): void {
	send({ id: `req-${++seq}`, type: "send_message", payload: { text } });
}

export function interrupt(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "interrupt", payload: { conversationId } });
}

export function newChat(): void {
	send({ id: `req-${++seq}`, type: "new_chat" });
}

export function switchConversation(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "switch_conversation", payload: { conversationId } });
}

/** 改客户端设置（ADR-0020 §P1）：服务端归一化后落盘，并随快照回推 */
export function setSettings(payload: { quickPhrases?: string[]; quickPhrasesEnabled?: boolean }): void {
	send({ id: `req-${++seq}`, type: "set_settings", payload });
}

export function approve(requestId: string, decision: "once" | "always" | "deny"): void {
	send({ id: `req-${++seq}`, type: "approve", payload: { requestId, decision } });
}

function handle(message: ServerMessage): void {
	if (message.type === "reply") {
		if (!message.ok) setAppState({ lastError: `${message.error.code}: ${message.error.message}` });
		return;
	}

	if (message.event === "snapshot") {
		setAppState({ snapshot: message.snapshot, lastError: null });
		return;
	}

	if (message.event === "message_delta") {
		applyDelta(message.conversationId, message.messageId, message.text);
	}
}

function applyDelta(conversationId: string, messageId: string, text: string): void {
	const snapshot: Snapshot | null = getAppState().snapshot;
	if (!snapshot || snapshot.active.conversationId !== conversationId) return;
	const messages = snapshot.active.messages.map((message) =>
		message.id === messageId ? appendTextToMessage(message, text) : message,
	);
	setAppState({ snapshot: { ...snapshot, active: { ...snapshot.active, messages } } });
}
