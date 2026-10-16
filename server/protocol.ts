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
	/** 消息数（扫描列表时给不出，打开过之后才知道 → 可选） */
	messageCount?: number;
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

/** pi 已有会话的列表行（ADR-0021 §1：只读展示） */
export type PiSessionSummary = {
	id: string;
	title: string;
	/** 会话开始时间（header 里的 timestamp） */
	startedAt: number;
	updatedAt: number;
	cwd: string;
	model: string | null;
	/** 会话文件路径（宿主打开它要用；界面不显示） */
	sessionPath: string;
};

/** 按项目（工作目录）分组的会话列表 */
/**
 * 附件引用（ADR-0020 §P3）：**只带引用，不带内容** —— 图片走 HTTP 上传（ADR-0004 的单条 ≤64KB），
 * 消息里只有 id。服务端据此读回文件（图片交给模型做视觉注入，其它只给路径引用）。
 */
export type AttachmentRef = {
	id: string;
	kind: "image" | "file";
	name: string;
	mime: string;
	bytes: number;
};

/** 可选模型（ADR-0020 §P2）：id 是 `provider/modelId`，label 给人看 */
export type ModelOption = { id: string; label: string };

/** 建议操作（ADR-0022）：模型用 [[action:suggest:...]] 给出的「下一步」，前端渲染成按钮 */
export type ActionItem = {
	id: string;
	/** 按钮显示文字 */
	label: string;
	/** 点击后发送的文本 */
	prompt: string;
};

/** 客户端设置（ADR-0020 §P1）：界面直接读快照里的这一份 */
export type SettingsView = {
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
};

export type PiProject = {
	cwd: string;
	name: string;
	sessions: PiSessionSummary[];
};

/** 当前引擎（ADR-0016）：界面靠它决定提示语与后续能力展示 */
export type EngineName = "pi" | "fake";

export type Snapshot = {
	protocolVersion: number;
	engine: EngineName;
	/** 可用模型列表（ADR-0020 §P2；打开会话后才拿得到，可能为空） */
	models: ModelOption[];
	/** 当前模型（`provider/model`；取不到为 null）——M3 起界面要能看见自己在跟谁说话 */
	model: string | null;
	/** pi 已有项目与会话（只读；ADR-0021 §1） */
	piProjects: PiProject[];
	/** 客户端设置（快捷短语等） */
	settings: SettingsView;
	/** 建议操作（ADR-0022）：新一轮开始时清空 */
	actions: ActionItem[];
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

export type SendMessageRequest = {
	id: string;
	type: "send_message";
	payload: { text: string; attachments?: AttachmentRef[] };
};
export type InterruptRequest = { id: string; type: "interrupt"; payload: { conversationId: string } };
export type ApproveRequest = {
	id: string;
	type: "approve";
	payload: { requestId: string; decision: ApprovalDecision };
};
export type GetStateRequest = { id: string; type: "get_state" };

/** 改客户端设置（ADR-0020 §P1）：只带要改的字段，服务端归一化后落盘 */
export type SetSettingsRequest = { id: string; type: "set_settings"; payload: Partial<SettingsView> };

/** 切换当前会话的模型（ADR-0020 §P2）：写进会话文件，续聊时不变 */
export type SetModelRequest = { id: string; type: "set_model"; payload: { modelId: string } };

export type ClientRequest =
	| SendMessageRequest
	| InterruptRequest
	| ApproveRequest
	| GetStateRequest
	| SetSettingsRequest
	| SetModelRequest
	| NewChatRequest
	| SwitchConversationRequest;

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
	"set_settings",
	"set_model",
];
const DECISIONS: ApprovalDecision[] = ["once", "always", "deny"];

function isAttachmentRef(value: unknown): value is AttachmentRef {
	if (!isRecord(value)) return false;
	const { id, kind, name, mime, bytes } = value;
	return (
		nonEmptyString(id) &&
		(kind === "image" || kind === "file") &&
		typeof name === "string" &&
		typeof mime === "string" &&
		typeof bytes === "number"
	);
}

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
		// 附件只校验形状（id/kind/name/mime/bytes）：真正的文件校验在服务端读回时做
		const attachments = Array.isArray(payload.attachments)
			? payload.attachments.filter(isAttachmentRef).slice(0, 5)
			: undefined;
		if (!nonEmptyString(payload.text) && !attachments?.length) return null;
		return {
			id,
			type: "send_message",
			payload: { text: String(payload.text ?? ""), ...(attachments?.length ? { attachments } : {}) },
		};
	}
	if (type === "set_model") {
		return nonEmptyString(payload.modelId) ? { id, type: "set_model", payload: { modelId: payload.modelId } } : null;
	}
	if (type === "set_settings") {
		// 结构有意放宽：真正的归一化在服务端 settings 模块（超长/重复/条数都在那里收敛）
		return { id, type: "set_settings", payload: payload as Partial<SettingsView> };
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
