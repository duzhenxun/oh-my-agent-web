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
import type {
	ApprovalMode,
	AttachmentRef,
	ClientRequest,
	ClientRequestType,
	ProjectPrefs,
	PromptTemplate,
	ServerMessage,
	Snapshot,
} from "./types.ts";
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

/** 发一条用户消息（可带附件引用；图片本体早就通过 HTTP 上传了） */
export function sendMessage(text: string, attachments?: AttachmentRef[]): void {
	send({
		id: `req-${++seq}`,
		type: "send_message",
		payload: attachments && attachments.length > 0 ? { text, attachments } : { text },
	});
}

export function interrupt(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "interrupt", payload: { conversationId } });
}

/** 新建会话；传 workspace = 在这个项目下新建（项目行上的「+」） */
export function newChat(workspace?: string): void {
	send(
		workspace
			? { id: `req-${++seq}`, type: "new_chat", payload: { workspace } }
			: { id: `req-${++seq}`, type: "new_chat" },
	);
}

export function switchConversation(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "switch_conversation", payload: { conversationId } });
}

/** 改客户端设置（ADR-0020 §P1）：服务端归一化后落盘，并随快照回推 */
/** 切换当前会话的模型（ADR-0020 §P2） */
/** 思考强度（P4）：档位由引擎给 */
export function setThinkingLevel(level: string): void {
	send({ id: `req-${++seq}`, type: "set_thinking_level", payload: { level } });
}

/** 审批模式（P4）：本会话放行 / 照旧询问 */
export function setApprovalMode(mode: ApprovalMode): void {
	send({ id: `req-${++seq}`, type: "set_approval_mode", payload: { mode } });
}

export function setModel(modelId: string): void {
	send({ id: `req-${++seq}`, type: "set_model", payload: { modelId } });
}

/** 列出已配置的 provider（ADR-0025）：结果由服务端以提示形式回传 */
export function requestProviders(): void {
	send({ id: `req-${++seq}`, type: "list_providers" });
}

export type UpsertProviderPayload = {
	provider: string;
	baseUrl: string;
	api?: string;
	apiKey?: string;
	models: { id: string; name?: string }[];
};

/** 逐模型测试（ADR-0026 C 期）：会发一次真实请求，所以用 HTTP 拿结构化结果 */
export async function testModel(
	provider: string,
	modelId: string,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message?: string }> {
	try {
		const response = await fetch(
			`/api/providers/${encodeURIComponent(provider)}/models/${encodeURIComponent(modelId)}/test`,
			{ method: "POST" },
		);
		const body = (await response.json()) as {
			ok?: boolean;
			status?: number;
			latencyMs?: number;
			message?: string;
			error?: { message?: string };
		};
		if (!response.ok) return { ok: false, message: body.error?.message ?? `HTTP ${response.status}` };
		return { ok: body.ok === true, status: body.status, latencyMs: body.latencyMs, message: body.message };
	} catch (cause) {
		return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** 写回单个模型的规格（ADR-0026 A 期）：数值用字符串传，服务端做校验与归一化 */
export function updateModel(provider: string, model: Record<string, unknown>): void {
	send({ id: `req-${++seq}`, type: "update_model", payload: { provider, model } });
}

/** 删除 provider（B 期）：模型表与凭证一起删；界面负责二次确认 */
export function deleteProvider(provider: string): void {
	send({ id: `req-${++seq}`, type: "delete_provider", provider });
}

/** 连通性测试（B 期）：只打一次 GET /models，不花钱 */
export function testProvider(provider: string): void {
	send({ id: `req-${++seq}`, type: "test_provider", provider });
}

/** 保存 provider 配置：apiKey 留空表示不改动已有 key（结果走提示条） */
export function upsertProvider(payload: UpsertProviderPayload): void {
	send({ id: `req-${++seq}`, type: "upsert_provider", payload });
}

export function setSettings(payload: {
	quickPhrases?: string[];
	quickPhrasesEnabled?: boolean;
	/** null = 恢复默认模板库（服务端专门处理这个手势） */
	templates?: PromptTemplate[] | null;
	/** 项目排序 / 置顶 / 别名（ADR-0028） */
	projectPrefs?: ProjectPrefs;
}): void {
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
