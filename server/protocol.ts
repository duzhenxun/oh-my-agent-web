/**
 * 三类消息：ClientRequest / ServerReply / ServerEvent。
 */

export const PROTOCOL_VERSION = 1;

export const SNAPSHOT_MESSAGE_LIMIT = 100;

export const MAX_FRAME_BYTES = 64 * 1024;
/** 工具输出摘录上限 */
export const TOOL_EXCERPT_CHARS = 2000;

export type TextBlock = { kind: "text"; text: string };
export type ThinkingBlock = { kind: "thinking"; text: string }; // 思考过程：默认折叠

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

export type MessageBlock = TextBlock | ThinkingBlock | ToolBlock | ErrorBlock;

export type UiMessage = {
	id: string;
	role: "user" | "assistant";
	ts: number;
	blocks: MessageBlock[];
};

export type Notice = {
	id: string;
	level: "info" | "warn" | "error";
	text: string;
	ts: number;
	/** 同一 key 的提示「**替换**」而不是堆叠（例：审批模式切换只占一行，跟着状态变） */
	key?: string;
};

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
	/** 正在跑的是**哪个会话**（不是"当前选中的那个"）—— 侧栏据此给对应行加转圈 */
	conversationId: string | null;
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
/** 附件引用（ADR-0020 §P3）：只带 id 不带内容；图片走 HTTP 上传，服务端据此读回文件。 */
export type AttachmentRef = {
	id: string;
	kind: "image" | "file";
	name: string;
	mime: string;
	bytes: number;
};

export type ModelOption = {
	id: string;
	label: string;
	/** 引擎报上来的端点（内置 provider 测试用） */ baseUrl?: string;
	api?: string;
};

export type ModelSpecView = {
	id: string;
	name: string;
	reasoning?: boolean;
	imageInput?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
};

export type ProviderView = {
	provider: string;
	/**
	 * custom = 我们（用户）在 models-store.json 里配的，可以编辑/删除；
	 */
	source: "custom" | "builtin";
	baseUrl: string;
	api: string;
	hasKey: boolean;
	keyHint: string | null;
	/** 自定义 header 只回传名称，不回传值 */
	headerNames?: string[];
	/** 逐模型规格（编辑器预填用；没配过就缺省，不算 0） */
	models: ModelSpecView[];
};

export type ActionItem = {
	id: string;
	/** 按钮显示文字 */
	label: string;
	/** 点击后发送的文本 */
	prompt: string;
};

/** 客户端设置（ADR-0020 §P1）：界面直接读快照里的这一份 */
/** 会话统计（顶部「会话信息」）：从 pi 的会话 JSONL 聚合出来 */
export type SessionStats = {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** 上下文占用（最近一条 assistant 的输入侧，近似"当前上下文多大"） */
	contextTokens: number;
};

/** 会话级偏好：置顶（排在该项目最前）/ 重命名（只改显示名）/ 归档（从列表隐藏） */
export type SessionPrefs = {
	pinned: string[];
	archived: string[];
	titles: Record<string, string>;
};

/** 项目偏好（ADR-0028）：显式顺序 + 置顶 + 显示名别名（身份仍是 cwd） */
export type ProjectPrefs = {
	order: string[];
	pinned: string[];
	aliases: Record<string, string>;
};

/** 提示词模板（P5）：一个模板 = 名字 + 一句说明 + 图标 + 正文 */
export type PromptTemplate = {
	id: string;
	name: string;
	description: string;
	icon: string;
	text: string;
	/** 软删除（P5）：内置模板「移出模板库」只隐藏，恢复默认模板即可复原 */
	hidden?: boolean;
};

export type SettingsView = {
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	/** 提示词模板库（P5）：点卡片直接填进输入框；可增删改、可恢复默认 */
	templates: PromptTemplate[];
	/** 项目排序 / 置顶 / 别名（ADR-0028） */
	projectPrefs: ProjectPrefs;
	/** 会话级偏好：置顶 / 重命名 / 归档（本轮新增） */
	sessionPrefs: SessionPrefs;
};

export type PiProject = {
	cwd: string;
	name: string;
	sessions: PiSessionSummary[];
};

/** 当前引擎（ADR-0016）：界面靠它决定提示语与后续能力展示 */
/** 引擎注册名（ADR-0024）：`pi` / `fake` 是内置的，新增引擎只是注册一个新名字 */
export type EngineName = string;

/** 引擎能力（ADR-0024 §2）：界面按它决定显示哪些控件 */
export type EngineCapabilities = {
	approvals: boolean;
	tools: boolean;
	modelSwitch: boolean;
	thinkingLevel: boolean;
	resume: boolean;
};

export type Snapshot = {
	protocolVersion: number;
	engine: EngineName;
	/** 可用模型列表（ADR-0020 §P2；打开会话后才拿得到，可能为空） */
	models: ModelOption[];
	/** 当前模型（`provider/model`；取不到为 null）——M3 起界面要能看见自己在跟谁说话 */
	model: string | null;
	/** 审批模式（P4）：本会话是「照旧询问」还是「全部放行」 */
	approvalMode: ApprovalMode;
	/** 当前引擎的能力（ADR-0024）：不支持的功能界面直接不显示，而不是点了报错 */
	engineCapabilities: EngineCapabilities;
	providers: ProviderView[];
	/** 已启用模型白名单（pi settings.json；空 = 全开） */
	enabledModels: string[];
	/** 排队中的后续消息（逐条下发，界面上的 × 才能真取消） */
	queued: { id: string; conversationId: string; text: string }[];
	runningByConversation: Record<string, { status: RunningState["status"]; turnStartedAt: number }>;
	/** 会话统计（顶部会话信息）：消息数 / 工具调用 / token 与上下文占用 */
	sessionStats: SessionStats | null;
	/** 本会话当前思考强度（null = 该模型不支持） */
	thinkingLevel: string | null;
	/** 可选的思考强度档位（空数组 → 界面隐藏该控件） */
	thinkingLevels: string[];
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

// 上行：请求

export type ApprovalDecision = "once" | "always" | "deny";

/** 发送方式：now=立刻发；queue=回合结束后发（排队）；steer=尝试插进当前回合（引导） */
export type SendMode = "now" | "queue" | "steer";

export type SendMessageRequest = {
	id: string;
	type: "send_message";
	payload: { text: string; attachments?: AttachmentRef[]; mode?: SendMode };
};
export type InterruptRequest = { id: string; type: "interrupt"; payload: { conversationId: string } };
export type ApproveRequest = {
	id: string;
	type: "approve";
	payload: { requestId: string; decision: ApprovalDecision };
};
export type GetStateRequest = { id: string; type: "get_state" };

/**
 * 改客户端设置（ADR-0020 §P1）：只带要改的字段，服务端归一化后落盘。
 */
export type SetSettingsRequest = {
	id: string;
	type: "set_settings";
	payload: Partial<Omit<SettingsView, "templates">> & { templates?: PromptTemplate[] | null };
};

/**
 * 审批模式（P4 第一件）：
 * 刻意**只存在内存**、不落盘：重启即回到 `ask`，避免"某天永久静默放行"这种事故。
 */
export type ApprovalMode = "ask" | "allow";

export type SetApprovalModeRequest = { id: string; type: "set_approval_mode"; payload: { mode: ApprovalMode } };

/** 列出已配置的 provider（ADR-0025） */
export type ListProvidersRequest = { id: string; type: "list_providers" };

/** 新增/覆盖 provider 配置（ADR-0025 §3）：apiKey 缺省 = 不改动已有 key */
export type UpsertProviderRequest = {
	id: string;
	type: "upsert_provider";
	payload: {
		provider: string;
		baseUrl: string;
		api?: string;
		apiKey?: string;
		headers?: Record<string, string>;
		models: { id: string; name?: string; contextWindow?: number }[];
	};
};

/** 删除 provider（ADR-0025 B 期）：模型表与凭证一起删，界面应二次确认 */
export type DeleteProviderRequest = { id: string; type: "delete_provider"; provider: string };

/** 连通性测试（ADR-0025 B 期）：只打一次 GET /models，不花钱也不改远端状态 */
export type TestProviderRequest = { id: string; type: "test_provider"; provider: string };

/** 写回单个模型的规格（ADR-0026 A 期）：能力 / 规格 / 价格 */
export type UpdateModelRequest = {
	id: string;
	type: "update_model";
	payload: { provider: string; model: Record<string, unknown> };
};

/** 从 provider 下移除一个模型（不动凭证） */
export type RemoveModelRequest = { id: string; type: "remove_model"; payload: { provider: string; modelId: string } };

export type CancelQueuedRequest = { id: string; type: "cancel_queued"; payload: { queueId: string } };

/** 启用/停用 provider（写 pi settings.json 的 enabledModels） */
export type SetEnabledModelsRequest = {
	id: string;
	type: "set_enabled_models";
	payload: { provider: string; enabled: boolean };
};
export type SetThinkingLevelRequest = { id: string; type: "set_thinking_level"; payload: { level: string } };

/** 切换当前会话的模型（ADR-0020 §P2）：写进会话文件，续聊时不变 */
export type SetModelRequest = { id: string; type: "set_model"; payload: { modelId: string } };

export type ClientRequest =
	| SendMessageRequest
	| InterruptRequest
	| ApproveRequest
	| GetStateRequest
	| SetSettingsRequest
	| SetModelRequest
	| SetApprovalModeRequest
	| ListProvidersRequest
	| UpsertProviderRequest
	| DeleteProviderRequest
	| TestProviderRequest
	| SetThinkingLevelRequest
	| CancelQueuedRequest
	| RemoveModelRequest
	| SetEnabledModelsRequest
	| UpdateModelRequest
	| NewChatRequest
	| SwitchConversationRequest;

/** 新建会话（M2）：服务端建好并推快照，active 指向它 */
/** 新建会话（ADR-0021 §2 起可指定项目：不传 = 继承当前会话的工作区） */
export type NewChatRequest = { id: string; type: "new_chat"; payload?: { workspace?: string } };

/** 切换会话（M2） */
export type SwitchConversationRequest = {
	id: string;
	type: "switch_conversation";
	payload: { conversationId: string };
};

export type ClientRequestType = ClientRequest["type"];

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

export { parseClientRequest } from "./protocol-parse.js";
