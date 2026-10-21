/**
 * 实时通道客户端（ADR-0032）：**纯 HTTP**，不用 WebSocket。
 *
 * 两条腿：
 *   - `GET /api/events`（SSE）：服务端 → 浏览器，快照 / 事件 / 增量都走它；
 *   - `POST /api/rpc`：浏览器 → 服务端，一次请求一个 ClientRequest，回包顺手处理。
 *
 * 为什么换成 HTTP：WS 要 Upgrade 头 + 自己的 Origin/Host 白名单，配域名、走反代、
 * 上 https 时处处要额外交代（Basic 凭据在握手阶段还未必带得上）。HTTP 没这些坑，
 * 只要代理能转发普通请求就能用。协议本身一点没改。
 *
 * 断线重连：SSE 自带重连，这里再叠一层指数退避（0.5s → 8s 封顶）。
 */
import { getAppState, setAppState } from "./store.ts";
import type {
	ApprovalMode,
	AttachmentRef,
	ClientRequest,
	ClientRequestType,
	ProjectPrefs,
	PromptTemplate,
	SendMode,
	ServerMessage,
	SessionPrefs,
	Snapshot,
} from "./types.ts";
import { appendTextToMessage } from "./lib/delta.ts";
import { sessionUrlFor } from "./session-url.ts";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

/**
 * 每个**标签页**自己的标识（ADR-0033）。
 *
 * 不能用 cookie：cookie 是同浏览器所有标签页共享的，A 切会话 B 会跟着变。
 * sessionStorage 天然是「每个标签页一份」，刷新保留、新标签页新值。
 */
const CLIENT_KEY = "agent-web-client";
function clientId(): string {
	let value = sessionStorage.getItem(CLIENT_KEY);
	if (!value) {
		value = crypto.randomUUID();
		sessionStorage.setItem(CLIENT_KEY, value);
	}
	return value;
}

let source: EventSource | null = null;
let attempt = 0;
let seq = 0;

export function connect(): void {
	if (source && source.readyState !== EventSource.CLOSED) return;

	setAppState({ connection: "connecting" });
	// SSE 带不了自定义头，所以用查询参数把标签页标识带过去
	const next = new EventSource(`/api/events?client=${encodeURIComponent(clientId())}`);
	source = next;

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

	next.addEventListener("error", () => {
		setAppState({ connection: "closed" });
		// EventSource 自己会重连，但间隔由浏览器定（可能很久）；这里再兜一层
		if (next.readyState === EventSource.CLOSED) {
			source = null;
			const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
			attempt += 1;
			setTimeout(connect, delay);
		} else {
			setAppState({ connection: "connecting" });
		}
	});
}

export function request(type: ClientRequestType): string {
	const id = `req-${++seq}`;
	send({ id, type } as ClientRequest);
	return id;
}

export function send(requestMessage: ClientRequest): void {
	void (async () => {
		try {
			const response = await fetch("/api/rpc", {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-client": clientId() },
				body: JSON.stringify(requestMessage),
			});
			if (!response.ok) {
				setAppState({ lastError: `请求失败：HTTP ${response.status}` });
				return;
			}
			const body = (await response.json()) as { frames?: string[] };
			// 同步产生的帧（reply / notice）在这里消费；异步事件走 SSE
			for (const frame of body.frames ?? []) {
				try {
					handle(JSON.parse(frame) as ServerMessage);
				} catch {
					// 单帧坏掉不影响其它帧
				}
			}
		} catch {
			setAppState({ lastError: "连接尚未就绪，稍后再试" });
		}
	})();
}

/** 取消一条排队消息（真删服务端队列） */
export function cancelQueued(queueId: string): void {
	send({ id: `req-${++seq}`, type: "cancel_queued", payload: { queueId } });
}

/** 拉一次权威快照（服务端会顺带重扫 pi 会话列表） */
export function requestState(): void {
	send({ id: `req-${++seq}`, type: "get_state" });
}

/** 发一条用户消息（可带附件引用；图片本体早就通过 HTTP 上传了） */
export function sendMessage(text: string, attachments?: AttachmentRef[], mode?: SendMode): void {
	send({
		id: `req-${++seq}`,
		type: "send_message",
		payload: {
			text,
			...(attachments && attachments.length > 0 ? { attachments } : {}),
			...(mode && mode !== "now" ? { mode } : {}),
		},
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
	// 先乐观高亮：外网往返几百毫秒，点下去没有反馈会以为没点上
	setAppState({ pendingActive: conversationId });
	// 先同步地址栏：点击侧栏后地址应立即跟随目标会话；服务端快照随后会校正状态。
	if (typeof window !== "undefined") {
		const href = sessionUrlFor(window.location.href, conversationId);
		window.history.replaceState(null, "", href);
	}
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
	headers?: Record<string, string>;
	/** 改名时传原名字 */
	previousProvider?: string;
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

/** 启用 / 停用 provider，或（传 modelId 时）单个模型；写 pi settings.json 的 enabledModels */
export function setProviderEnabled(provider: string, enabled: boolean, modelId?: string): void {
	send({
		id: `req-${++seq}`,
		type: "set_enabled_models",
		payload: { provider, enabled, ...(modelId ? { modelId } : {}) },
	});
}

/** 从 provider 下移除一个模型（不动凭证） */
export function removeModel(provider: string, modelId: string): void {
	send({ id: `req-${++seq}`, type: "remove_model", payload: { provider, modelId } });
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
	/** 会话级偏好：置顶 / 重命名 / 归档 */
	sessionPrefs?: SessionPrefs;
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
		const pending = getAppState().pendingActive;
		setAppState({
			snapshot: message.snapshot,
			lastError: null,
			// 服务端已经切过去了 → 乐观值可以退休
			...(pending && message.snapshot.active.conversationId === pending ? { pendingActive: null } : {}),
		});
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
