/** 三类消息：ClientRequest / ServerReply / ServerEvent。 */
export const PROTOCOL_VERSION = 1;

export const SNAPSHOT_MESSAGE_LIMIT = 100;
export const TOOL_EXCERPT_CHARS = 2000; // 工具输出摘录上限

export type TextBlock = { kind: "text"; text: string };
export type ThinkingBlock = { kind: "thinking"; text: string }; // 思考过程：默认折叠

export type ToolBlock = {
	kind: "tool";
	toolCallId: string;
	name: string;
	argsSummary: string;
	/**
	 * 完整参数（原始命令 / 完整 JSON），比 `argsSummary` 长时才有值。
	 *
	 * 为什么要两份：摘要是给**一行预览**用的（截到 200 字），`bash` 的长命令
	 * 正好在那 200 字之后才关键 —— 展开了也看不见全。这一份留给展开后的
	 * 「完整命令 + 复制」（服务端也截，上限 4000 字，不让快照被参数撞大）。
	 */
	argsFull?: string;
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
	/** 这条助手消息**跑完**的时间（界面显示「完成时间」，不再显示开始时间） */
	endedAt?: number;
	blocks: MessageBlock[];
	steer?: boolean; // 这条用户消息是「插队」插进正在跑的那一轮的（界面打标签，和「排队」区分开）
	model?: string; // 这条回复用的模型（`provider/model`）：历史按当时那个，不跟当前选择变
	thinkingMs?: number; // 「思考」累计耗时（毫秒）：折叠行显示「· 耗时 2s」；内存态，重开历史就没有
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }; // 尾注的 token 用量 / 花费（美元，拿不到就不给）
};

export type Notice = {
	id: string;
	level: "info" | "warn" | "error";
	text: string;
	ts: number;
	/** 同一 key 的提示「**替换**」而不是堆叠（例：审批模式切换只占一行，跟着状态变） */
	key?: string;
	/**
	 * 这条提示属于哪个会话（有才带）。
	 *
	 * 为什么需要：`state.notices` 是**全局**一份，事件也广播给所有客户端 ——
	 * 于是 A 会话报的错会在 B 会话、在另一个窗口的提示条上一起冒出来。
	 * 带上会话 id 后，界面只显示「当前看的这个会话」的提示（没带 id 的仍全局显示，
	 * 例如连接断开这类跟会话无关的）。
	 */
	conversationId?: string;
};

export type ConversationMeta = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	workspace: string;
	/** 消息数（扫描列表时给不出，打开过之后才知道 → 可选） */
	messageCount?: number;
	/**
	 * 临时会话：只在内存里，**不落盘、不进历史**，服务端重启 / 关掉就没了。
	 * 界面上要显式标出来（提示条 + 侧栏角标），因为「以为存下来了、其实没存」代价很大。
	 * 「保存为正式对话」之后这个标记才清掉。
	 */
	ephemeral?: boolean;
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
	/** 会话文件路径（宿主打开它要用；界面不显示）。引擎不落文件时为 undefined */
	sessionPath?: string;
	/**
	 * 引擎自己的会话句柄（codex = threadId）：打开 / 改名 / 删除都靠它；pi 用文件路径。
	 */
	engineSessionId?: string;
};

/** 附件引用（ADR-0020 §P3）：只带 id 不带内容（图片走 HTTP 上传） */
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
	/**
	 * 模型自己的协议 / 端点（内置目录里逐模型给的）：
	 * 同一个 provider 可能混用多种协议（OpenCode Go 就有 anthropic / openai / gemini 三种），
	 * 试连时必须按模型自己的走，不能拿 provider 级的默认值充数。
	 */
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	imageInput?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
	/** 分时价格（ADR-0026 D 期）：编辑器回填用；没配就是缺省 = 全天一个价 */
	costSchedule?: PriceSegment[];
};

export type ProviderView = {
	provider: string;
	/**
	 * custom = 用户在 models-store.json 里配的，可以编辑/删除；
	 */
	source: "custom" | "builtin";
	baseUrl: string;
	api: string;
	hasKey: boolean;
	keyHint: string | null;
	/**
	 * 凭证来源（ADR-0025 / 订阅登录）：
	 *   apiKey = auth.json 里存着 API key；
	 *   oauth  = 订阅登录（ChatGPT Plus/Pro 等）写进去的 access/refresh，**没有 API key**；
	 *   none   = 两者都没有。
	 * `hasKey` 保持原义（只表示有没有 API key），判断「能不能用」请用 `credential`。
	 */
	credential?: "apiKey" | "oauth" | "none";
	/** 订阅凭据的可见信息（只在 credential === "oauth" 时有；不含任何 token 原文） */
	oauth?: { expired: boolean; expiresAt?: number; accountHint: string | null };
	/** 自定义 header 只回传名称，不回传值 */
	headerNames?: string[];
	/** 逐模型规格（编辑器预填用；没配过就缺省，不算 0） */
	models: ModelSpecView[];
	/**
	 * 引擎目录里这个 provider 有多少模型 —— **只在 `models` 为空时出现**：
	 * 没配 key 的时候引擎拿不到清单，界面靠这个说清「填一把 key 有几个可用」。
	 */
	modelCount?: number;
	/** 引擎目录给的显示名（xAI / Google Vertex AI…）；没有就用 provider 名 */
	label?: string;
	/**
	 * 真的是「官方内置」= 引擎自己的 provider 目录里就有它。
	 * 区分于 `source: "builtin"` 的另一种含义（用户手写进 pi 的 models.json 的条目）：
	 * 后者是我们能编辑的配置，不该混进「官方内置服务商」那一组。
	 */
	official?: boolean;
	/** 只支持订阅登录（如 openai-codex）：填 API key 没用 */
	oauthOnly?: boolean;
	/** 除 key 外还要端点 / 云凭证（bedrock、vertex、azure、cloudflare）：只填 key 跑不起来 */
	needsExtraConfig?: boolean;
};

export type ActionItem = {
	id: string;
	/** 按钮显示文字 */
	label: string;
	/** 点击后发送的文本 */
	prompt: string;
};

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
	/**
	 * 整段会话的总花费（美元，Σ 每次调用的 usage.cost.total）。
	 * 可选：provider 没配价格 / 免费模型时 pi 压根不给 cost，那种情况宁可不显示也不编 0。
	 */
	cost?: number;
};

export type { ProjectPrefs, PromptTemplate, SessionPrefs, SettingsView } from "./protocol-settings.js";
import type { PromptTemplate, SettingsView } from "./protocol-settings.js";
import type { PriceSegment } from "./util/pricing.js";

export type PiProject = {
	cwd: string;
	name: string;
	sessions: PiSessionSummary[];
};

/** 引擎注册名（ADR-0024）：`pi` / `fake` 是内置的，新增引擎只是注册一个新名字 */
export type EngineName = string;

/** 引擎能力（ADR-0024 §2）：界面按它决定显示哪些控件 */
export type EngineCapabilities = {
	approvals: boolean;
	tools: boolean;
	modelSwitch: boolean;
	thinkingLevel: boolean;
	resume: boolean;
	/**
	 * 有没有「子代理」（并行委派 + 面板）。可选：只有 pi 引擎实现了它，
	 * 没写的引擎按「不支持」处理（界面就不出现子代理模块，而不是点了报错）。
	 */
	subagents?: boolean;
	/**
	 * 能不能把一条消息**插进正在跑的这一轮中间**（ADR-0043）。
	 *
	 * 只有 pi 的 SDK 有 `streamingBehavior: "steer"` 这个语义；codex / dsh / opencode 的
	 * 底层协议（JSON-RPC / ACP）都是「一个会话同时只能跑一条 prompt」。
	 * 没写的引擎按「不支持」处理：宿主会把「插队」降级成「排队」，
	 * 而不是硬发第二条 —— 那会覆盖引擎自己的活跃回合，导致永久 busy 或整轮输出丢失。
	 */
	steer?: boolean;
	/**
	 * 能不能给某个模型「测速」（真跑一个最小回合，量首字节延迟 / 出字速度）。
	 *
	 * 有它 → 「模型」面板里出现测速按钮；没有就不画（pi 的测速在 provider 面板，
	 * 走的是另一条路：工作台自己持有 key，直接发 HTTP，见 providers/model-test.ts）。
	 */
	modelProbe?: boolean;
	/**
	 * 子代理能按「逐工具白名单」隔离吗（pi：能，模板勾了 read/grep 就只有只读工具）。
	 *
	 * codex 给的是 `false`：它的隔离单位是**沙箱 + 审批策略**（只读沙箱 / 可写工作区），
	 * 没有「不给 bash 但给 grep」这种粒度。面板据此提示一句，避免让人以为勾选真的生效。
	 * 不写 = 按 true 处理（pi 的现状）。
	 */
	subagentToolWhitelist?: boolean;
	/**
	 * 能不能开**临时会话**：只在内存里跑、不落盘、不进历史，可一键「保存为正式对话」。
	 *
	 * 要求引擎的会话存储支持「纯内存会话」（pi 的 `SessionManager.inMemory` 正好是它）。
	 * 不写 = 不支持：顶栏不出现「临时对话」按钮，而不是点了报错。
	 */
	ephemeralChat?: boolean;
	/**
	 * 能不能「从某条消息派生一条新会话」（分支）。
	 *
	 * 要求引擎能按 entry id 裁剪历史并另存成新会话。不写 = 不支持：消息尾注不出现分支图标。
	 */
	forkChat?: boolean;
};

// ---------------------------------------------------------------------------
// 子代理（多开、可管理）
// ---------------------------------------------------------------------------

/** 一次子代理运行的状态机（宿主只认这五个） */
export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "aborted";

/** 面板上一行 = 一次子代理运行（引擎推上来，宿主投影进快照） */
export type SubagentRunView = {
	id: string;
	/** 属于哪个会话（面板只显示当前会话的；侧栏不受影响） */
	conversationId: string;
	/** 用的是哪个模板 */
	profile: string;
	/** 模板显示名（模板改名后老记录仍显示当时的名字，取不到就回落 profile） */
	label: string;
	/** 一句话说明这次让它干什么（模型的 description 参数） */
	description: string;
	status: SubagentStatus;
	/** 完整的任务原文（展开看全 / 复制） */
	task: string;
	startedAt: number;
	endedAt?: number;
	/** 子会话文件路径（能拿它去 pi 里续上，也是「在哪看」的答案） */
	sessionPath?: string;
	/** 这个子代理实际用的模型（`provider/model`） */
	model?: string;
	tokens?: { input: number; output: number; total: number };
	cost?: number;
	toolCalls?: number;
	/** 完成时的最终文本（面板里可展开） */
	result?: string;
	error?: string;
};

/** 一个子代理模板（面板左侧列表 + 编辑表单） */
export type SubagentProfileView = {
	id: string;
	label: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	thinking?: string;
	maxTurns?: number;
	enabled: boolean;
	builtin: boolean;
};

/** 子代理总开关 + 并发上限 */
export type SubagentSettingsView = { enabled: boolean; concurrency: number };

/** 可选引擎（顶栏切换面板的列表项）；当前是谁由 `Snapshot.engine` 说，不重复表达 */
export type EngineOption = {
	name: EngineName;
	/** 显示名（pi / 假引擎 / Codex） */
	label: string;
	/** 短标签（PI / FAKE / CODEX） */
	badge: string;
	/** 一句话能力说明：如实写，别夸大（ADR-0024 §2） */
	description: string;
	/**
	 * 这个引擎自己的版本号（面板每一行各显各的）；探不到为 null。
	 *
	 * 与 `Snapshot.versions.engine` 的区别：那个只描述**当前**引擎，而且是引擎握手给的最准的值；
	 * 这里是列表里每个引擎各自的（非当前引擎靠一次轻量探测，见 engine/engine-versions.ts）。
	 */
	version?: string | null;
	capabilities: EngineCapabilities;
};

export type Snapshot = {
	protocolVersion: number;
	engine: EngineName;
	/** 可切换的引擎清单（含当前这个）：顶栏切换面板靠它渲染，不需要额外接口 */
	engines: EngineOption[];
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
	/** 排队中的后续消息（逐条下发，界面上的 × 才能真取消）
	 *  `mode`：queue = 等这一轮结束再发；steer = 插队（先挂在宿主，到 step 边界注入，注入前可取消） */
	queued: { id: string; conversationId: string; text: string; mode: QueuedMode }[];
	/** 当前会话的子代理运行记录（新→旧）；引擎不支持时是空数组 */
	subagents: SubagentRunView[];
	/** 子代理模板（内置 + 用户文件）；空数组 = 这个引擎没有子代理 */
	subagentProfiles: SubagentProfileView[];
	/** 子代理总开关与并发上限 */
	subagentSettings: SubagentSettingsView;
	runningByConversation: Record<string, { status: RunningState["status"]; turnStartedAt: number }>;
	/** 会话统计（顶部会话信息）：消息数 / 工具调用 / token 与上下文占用 */
	sessionStats: SessionStats | null;
	/** 本会话当前思考强度（null = 该模型不支持） */
	thinkingLevel: string | null;
	/** 可选的思考强度档位（空数组 → 界面隐藏该控件） */
	thinkingLevels: string[];
	/** pi 已有项目与会话（ADR-0021 §1）。可选：带 `slim=1` 的客户端只在清单变了时才收到，省下上百 KB */
	piProjects?: PiProject[];
	/**
	 * 版本号（抬头显示）：web = agent-web 自己，engine = 引擎 SDK（拿不到为 null）。
	 * latest = 上游（GitHub `main`）最新版本，查不到为 null（离线/超时）；
	 * outdated = 上游比本机新，抬头那行标红提醒「有新版」。都由服务端算好，界面不自己比版本号。
	 */
	versions: { web: string; engine: string | null; latest: string | null; outdated: boolean };
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

/** 发送方式：now=立刻发；queue=回合结束后发（排队）；steer=尝试插进当前回合（插队） */
export type SendMode = "now" | "queue" | "steer";

/**
 * 待发消息的两种语义（界面统一成同一种「待发行」，只是标签不同）：
 *   - `queue`：等这一轮结束再发（普通排队）；
 *   - `steer`：插队 —— 先挂在宿主，到当前回合的 step 边界再注入，**注入前可以撤回 / 取消**。
 *
 * 为什么插队也要挂一下：一旦交给了引擎，「撤回」就没有任何手段了。挂到注入点这几秒
 * 正好是「趁它还没插进去」那个窗口，而注入时机（step 边界）本来就是引擎插队的时机。
 */
export type QueuedMode = "queue" | "steer";

export type SendMessageRequest = {
	id: string;
	type: "send_message";
	payload: { text: string; attachments?: AttachmentRef[]; mode?: SendMode };
};
export type InterruptRequest = { id: string; type: "interrupt"; payload: { conversationId: string } };
/** 改会话显示名：写进 pi 的会话文件（session_info），不另存本地变量 */
export type RenameSessionRequest = {
	id: string;
	type: "rename_session";
	payload: { conversationId: string; title: string };
};
/**
 * 让 AI 按会话内容重新起名：只给会话 id，标题由服务端生成后落盘
 * （提示词 / 清洗 / 兜底都在服务端，前后端不同步一套规则）。
 */
type SuggestTitleRequest = {
	id: string;
	type: "suggest_title";
	payload: { conversationId: string };
};
export type ApproveRequest = {
	id: string;
	type: "approve";
	payload: { requestId: string; decision: ApprovalDecision };
};
export type GetStateRequest = { id: string; type: "get_state" };

/** 改客户端设置（ADR-0020 §P1）：只带要改的字段，服务端归一化后落盘。 */
export type SetSettingsRequest = {
	id: string;
	type: "set_settings";
	payload: Partial<Omit<SettingsView, "templates">> & { templates?: PromptTemplate[] | null };
};

/**
 * 审批模式（P4 / ADR-0034）：`allow` = 全部放行（默认），`ask` = 危险操作先问；只存内存、不落盘。
 * **按会话**生效：快照里的 `approvalMode` 是「当前这条会话」的那一份。
 */
export type ApprovalMode = "ask" | "allow";

/**
 * 改审批模式。
 * `conversationId` 是「界面正看着哪条会话」—— 不带就落到服务端的全局 activeId（老客户端兼容）。
 */
export type SetApprovalModeRequest = {
	id: string;
	type: "set_approval_mode";
	payload: { mode: ApprovalMode; conversationId?: string };
};

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
		/** 改名时传原名字（服务端据此把旧条目搬过去） */
		previousProvider?: string;
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
	payload: { provider: string; enabled: boolean; /** 给了就是模型级开关 */ modelId?: string };
};
export type SetThinkingLevelRequest = { id: string; type: "set_thinking_level"; payload: { level: string } };

/** 新建/覆盖一个子代理模板（写 `~/.pi/agent/agents/<id>.md`） */
export type SaveSubagentProfileRequest = {
	id: string;
	type: "save_subagent_profile";
	payload: { profile: SubagentProfileView };
};

/** 删掉一个用户模板（内置模板只能停用，删会回一条可读错误） */
export type DeleteSubagentProfileRequest = {
	id: string;
	type: "delete_subagent_profile";
	payload: { profileId: string };
};

/** 子代理总开关 / 并发上限（落 `agents/settings.json` 里我们自己那个键） */
export type SetSubagentSettingsRequest = {
	id: string;
	type: "set_subagent_settings";
	payload: { enabled?: boolean; concurrency?: number };
};

/** 停掉一个正在跑的子代理（只停它，不动主会话那一轮） */
export type InterruptSubagentRequest = {
	id: string;
	type: "interrupt_subagent";
	payload: { runId: string };
};

/** 切换当前会话的模型（ADR-0020 §P2）：写进会话文件，续聊时不变 */
export type SetModelRequest = { id: string; type: "set_model"; payload: { modelId: string } };

/** 切换智能体引擎（零重启）：项目 / 模型 / 能力矩阵都换；回合在飞时拒绝（engine.busy）。 */
export type SetEngineRequest = { id: string; type: "set_engine"; payload: { engine: string } };

/** 「想一想」：隐藏回合重新要一批建议（count = 这一批几条，手机用 3；1~5） */
export type RefreshActionsRequest = {
	id: string;
	type: "refresh_actions";
	payload?: { conversationId?: string; count?: number };
};

export type ClientRequest =
	| SetEngineRequest
	| RefreshActionsRequest
	| SendMessageRequest
	| InterruptRequest
	| RenameSessionRequest
	| SuggestTitleRequest
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
	| SaveSubagentProfileRequest
	| DeleteSubagentProfileRequest
	| SetSubagentSettingsRequest
	| InterruptSubagentRequest
	| CancelQueuedRequest
	| RemoveModelRequest
	| SetEnabledModelsRequest
	| UpdateModelRequest
	| NewChatRequest
	| PersistConversationRequest
	| CloseEphemeralRequest
	| ForkSessionRequest
	| SwitchConversationRequest
	| MoveSessionRequest;

/** 新建会话（ADR-0021 §2 起可指定项目：不传 = 继承当前会话的工作区） */
export type NewChatRequest = {
	id: string;
	type: "new_chat";
	payload?: {
		workspace?: string;
		/** 开一条临时会话（内存里跑、不落盘）；引擎不支持时服务端退回普通会话并提示 */
		ephemeral?: boolean;
	};
};

/**
 * 把临时会话**转正**：把内存里的条目写成一个真正的会话文件，id 不变。
 * 转正之后它才进历史列表、才能被 CLI 看见。
 */
type PersistConversationRequest = {
	id: string;
	type: "persist_conversation";
	payload: { conversationId: string };
};

/**
 * 关闭临时会话：内存里的消息、引擎句柄、侧栏那一行一起扔掉。
 *
 * 跟「删除」不是一回事：删除针对**磁盘上的会话文件**（pi 的做法是改名成 `.deleted-时间戳`，
 * 还能从磁盘捞回来），而临时会话（`--no-session`）压根没有文件 —— 它只能被关闭，
 * 关掉就真没了。所以服务端这条路径不碰磁盘，只做本地清场。
 */
type CloseEphemeralRequest = {
	id: string;
	type: "close_ephemeral";
	payload: { conversationId: string };
};

/**
 * 从某条消息派生一条新会话（分支）。
 *
 * 与 pi CLI 的 `/fork`、`/clone` 同义：新会话只保留**从根到这条消息**的历史，
 * 落在同一个工作区里（分支是「同一个项目里的另一条思路」，不换目录）。
 *
 * `messageId` 是界面上的 `UiMessage.id`（= 会话 entry id）：服务端负责把它换算成
 * 「这一轮的最后一个 entry」—— 助手气泡是多条 entry 合并出来的，直接按首条切会把工具块砍掉。
 */
type ForkSessionRequest = {
	id: string;
	type: "fork_session";
	payload: { conversationId: string; messageId: string };
};

/** 切换会话（M2） */
export type SwitchConversationRequest = {
	id: string;
	type: "switch_conversation";
	payload: { conversationId: string };
};

/**
 * 把一条会话移到另一个项目（改动工作目录 cwd）。
 *
 * 对 pi 引擎：重写会话文件 header 的 `cwd` 并把文件搬到新项目的会话目录，
 * 会话 id 与历史不变（不是派生，是搬家）；对不支持搬家（没落盘 / 引擎没这个能力）的会话返回错误。
 */
export type MoveSessionRequest = {
	id: string;
	type: "move_session";
	payload: { conversationId: string; workspace: string };
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
