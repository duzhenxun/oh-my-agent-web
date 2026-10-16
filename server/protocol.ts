/**
 * wire 协议唯一事实源（ADR-0002 纪律①、ADR-0004、ADR-0012）。
 *
 * ⚠️ 这个文件是线上消息规格的**唯一**定义处：
 *   - 只允许类型与常量，不允许任何 import、不允许任何运行时逻辑（`web` 侧要直接吃它）；
 *   - 改了这里必须同步 `web/src/types.ts`（它只是 shim），守卫 `check-protocol-sync.mjs` 会红。
 *
 * 消息分三类（ADR-0004 §2）：
 *   上行请求 `ClientRequest`（必带 id）
 *   下行应答 `ServerReply`（回同一个 id）
 *   下行事件 `ServerEvent`（不需要回执：snapshot / message_delta / notice）
 */

export const PROTOCOL_VERSION = 1;

/** 快照里携带的最近消息条数（ADR-0012：N=100，前后端共用这一个常量） */
export const SNAPSHOT_MESSAGE_LIMIT = 100;

/** WS 单条消息载荷上限（ADR-0004 §5）；超过一律截断并打标记 */
export const MAX_FRAME_BYTES = 64 * 1024;

/** 工具输出在界面上保留的摘录字符数（超出标 truncated） */
export const TOOL_EXCERPT_CHARS = 2000;

// ---------------------------------------------------------------------------
// 下行：快照（ADR-0012 的字段清单，前端渲染的唯一事实源）
// ---------------------------------------------------------------------------

export type TextBlock = { kind: "text"; text: string };

export type ToolBlock = {
	kind: "tool";
	toolCallId: string;
	name: string;
	argsSummary: string;
	status: "running" | "ok" | "failed";
	outputExcerpt: string;
	truncated: boolean;
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
};

export type ErrorBlock = { kind: "error"; code: string; message: string };

export type MessageBlock = TextBlock | ToolBlock | ErrorBlock;

export type UiMessage = {
	id: string;
	role: "user" | "assistant";
	ts: number;
	blocks: MessageBlock[];
};

export type Notice = { id: string; level: "info" | "warn" | "error"; text: string; ts: number };

export type ConversationMeta = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	workspace: string;
	messageCount: number;
};

export type RunningState = {
	status: "idle" | "streaming" | "awaiting_approval" | "error";
	turnStartedAt: number | null;
	/** 当前助手文本（增量另走 message_delta 事件，避免每字全量重推） */
	streamingText: string;
	activeTool: { name: string; argsSummary: string; startedAt: number } | null;
};

export type PendingApproval = {
	requestId: string;
	toolName: string;
	argsSummary: string;
	/** 为什么要问（人话） */
	riskNote: string;
	/** 「这类」的人类可读描述（命令名 / 目标目录），用于「总是允许这类」 */
	scopeHint: string;
};

export type TerminalMeta = { id: string; cols: number; rows: number; alive: boolean };

export type FilesMeta = { root: string; treeVersion: number };

export type Snapshot = {
	protocolVersion: number;
	conversations: ConversationMeta[];
	active: {
		conversationId: string | null;
		messages: UiMessage[];
		hasMoreBefore: boolean;
	};
	running: RunningState;
	pendingApproval: PendingApproval | null;
	terminal: TerminalMeta | null;
	files: FilesMeta | null;
	notices: Notice[];
};

// ---------------------------------------------------------------------------
// 上行：请求
// ---------------------------------------------------------------------------

export type ApprovalDecision = "once" | "always" | "deny";

export type SendMessageRequest = { id: string; type: "send_message"; payload: { text: string } };
export type InterruptRequest = { id: string; type: "interrupt"; payload: { conversationId: string } };
export type ApproveRequest = {
	id: string;
	type: "approve";
	payload: { requestId: string; decision: ApprovalDecision };
};
export type GetStateRequest = { id: string; type: "get_state" };

export type ClientRequest =
	SendMessageRequest | InterruptRequest | ApproveRequest | GetStateRequest | NewChatRequest | SwitchConversationRequest;

/** 新建会话（M2）：服务端建好并推快照，active 指向它 */
export type NewChatRequest = { id: string; type: "new_chat" };

/** 切换会话（M2） */
export type SwitchConversationRequest = {
	id: string;
	type: "switch_conversation";
	payload: { conversationId: string };
};

export type ClientRequestType = ClientRequest["type"];

// ---------------------------------------------------------------------------
// 下行：应答与事件
// ---------------------------------------------------------------------------

export type ProtocolError = { code: string; message: string };

export type ServerReply =
	| { type: "reply"; id: string; ok: true; result?: unknown }
	| { type: "reply"; id: string; ok: false; error: ProtocolError };

export type SnapshotEvent = { type: "event"; event: "snapshot"; snapshot: Snapshot };
export type MessageDeltaEvent = {
	type: "event";
	event: "message_delta";
	conversationId: string;
	messageId: string;
	text: string;
};
export type NoticeEvent = { type: "event"; event: "notice"; notice: Notice };

export type ServerEvent = SnapshotEvent | MessageDeltaEvent | NoticeEvent;

export type ServerMessage = ServerReply | ServerEvent;

// ---------------------------------------------------------------------------
// 校验（纯函数：服务端用它拒绝垃圾输入，单测直接覆盖）
// ---------------------------------------------------------------------------

const REQUEST_TYPES: ClientRequestType[] = [
	"send_message",
	"interrupt",
	"approve",
	"get_state",
	"new_chat",
	"switch_conversation",
];
const DECISIONS: ApprovalDecision[] = ["once", "always", "deny"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * 解析并校验一条上行请求。返回 null 表示「不是合法请求」，
 * 调用方负责回 `protocol.unknown_type` / `protocol.bad_payload`。
 */
export function parseClientRequest(raw: unknown): ClientRequest | null {
	if (!isRecord(raw)) return null;
	const { id, type } = raw;
	if (!nonEmptyString(id) || !nonEmptyString(type)) return null;
	if (!REQUEST_TYPES.includes(type as ClientRequestType)) return null;

	if (type === "get_state" || type === "new_chat") return { id, type };

	const payload = raw.payload;
	if (!isRecord(payload)) return null;

	if (type === "send_message") {
		return nonEmptyString(payload.text) ? { id, type: "send_message", payload: { text: payload.text } } : null;
	}
	if (type === "switch_conversation") {
		return nonEmptyString(payload.conversationId)
			? { id, type: "switch_conversation", payload: { conversationId: payload.conversationId } }
			: null;
	}
	if (type === "interrupt") {
		return nonEmptyString(payload.conversationId)
			? { id, type: "interrupt", payload: { conversationId: payload.conversationId } }
			: null;
	}
	return nonEmptyString(payload.requestId) && DECISIONS.includes(payload.decision as ApprovalDecision)
		? { id, type: "approve", payload: { requestId: payload.requestId, decision: payload.decision as ApprovalDecision } }
		: null;
}
