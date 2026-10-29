/**
 * Runtime 的公开类型（ADR-0010 的拆分）：从 runtime.ts 搬出来，让那边留在 400 行护栏内。
 * 对外入口不变 —— runtime.ts 仍 `export type { Runtime, Result, RuntimeEmit }`。
 */
import type { ClientView } from "./client-view.js";
import type {
	AttachmentRef,
	ApprovalDecision,
	ApprovalMode,
	PiProject,
	Notice,
	ProtocolError,
	SendMode,
	ServerEvent,
	ProviderView,
	Snapshot,
	SubagentProfileView,
	SubagentSettingsView,
} from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import type { SuggestTitleResult } from "./suggest-title.js";
import type { EnginePort } from "../engine/port.js";
import type { EngineCatalog } from "../engine/catalog.js";
import type { RuleStore } from "../approval/rules.js";
import type { SettingsStore } from "./settings.js";
import type { ConversationSeed } from "./conversation-create.js";

export type RuntimeEmit = {
	snapshot(snapshot: Snapshot): void;
	event(event: ServerEvent): void;
};
export type Result = { ok: true } | { ok: false; error: ProtocolError };
export type Runtime = {
	init(): Promise<void>;
	snapshot(): Snapshot;
	/** 按客户端生成快照：`active` 用这个客户端自己选中的会话（ADR-0033） */
	snapshotFor(clientId: string | undefined): Snapshot;
	/** 客户端记录（看哪个会话 / 是否 slim / 清单版本）：SSE 连接与断开时要用 */
	clientView: ClientView;
	state(): ServerState;
	sendMessage(
		text: string,
		attachments?: AttachmentRef[],
		mode?: SendMode,
		targetConversationId?: string,
		/** 发起请求的客户端：懒建会话时要把它的视图指到新会话（ADR-0033） */
		clientId?: string,
	): Promise<Result>;
	/** 中断某个会话的回合；不给就挑「当前会话 / 第一个在跑的」 */
	interrupt(conversationId?: string): Promise<Result>;
	approve(requestId: string, decision: ApprovalDecision): Result;
	newConversation(workspace?: string, clientId?: string, seed?: ConversationSeed): Promise<Result>;
	/** 临时会话转正：把内存里的内容写成真正的会话文件（id 不变） */
	persistConversation(conversationId: string): Promise<Result>;
	/** 关闭临时会话：内存里的内容直接丢弃（没有磁盘文件，关掉就真没了） */
	closeEphemeral(conversationId: string): Result;
	/** 从某条消息派生新会话（分支）；原会话不动，自动切到新的那条 */
	forkSession(conversationId: string, messageId: string, clientId?: string): Promise<Result>;
	/** 改会话显示名（写进 pi 的会话文件；成功后重扫列表把新名字带回来） */
	renameSession(conversationId: string, title: string): Promise<Result>;
	/**
	 * 让 AI 按会话内容重新起名（一次性问答 → 清洗 → 走 `renameSession` 落盘）。
	 * 成功时把最终用的标题带回来，界面可直接拿来提示。
	 */
	suggestSessionTitle(conversationId: string): Promise<SuggestTitleResult>;
	/** 删除会话：引擎原生删除（codex）或文件改名（pi）；已经不在的按成功处理（`gone`） */
	deleteSession(
		conversationId: string,
	): Promise<
		| { ok: true; mode: "engine" | "file" | "gone"; movedTo?: string }
		| { ok: false; error: { code: string; message: string } }
	>;
	/** 把会话拖到另一个项目（改 cwd，id 与历史不变） */
	moveSession(
		conversationId: string,
		workspace: string,
	): Promise<{ ok: true; workspace: string } | { ok: false; error: { code: string; message: string } }>;
	/** 改客户端设置（ADR-0020 §P1）：归一化 → 落盘 → 推快照 */
	applySettings(patch: unknown): Promise<Result>;
	/** 切换当前会话的模型（ADR-0020 §P2） */
	setModel(modelId: string): Promise<Result>;
	/** 思考强度（P4）：档位由引擎给，不支持时界面隐藏控件 */
	setThinkingLevel(level: string): Promise<Result>;
	/** 「想一想」：隐藏回合重新向模型要一批建议（不进对话区/历史） */
	refreshActions(conversationId?: string, count?: number): Promise<Result>;
	/** 只推一帧快照（不制造提示条） */
	pushSnapshot(): void;
	/** 热重载模型表（改完 provider / 模型配置后调用，免重启） */
	reloadModels(): Promise<void>;
	/** 取消一条排队消息（真删队列，不是只从界面移除） */
	cancelQueued(queueId: string): Result;
	/**
	 * 审批模式（P4）：**按会话**存在内存里（不落盘），重启回到默认 allow。
	 * `conversationId` 由界面给（它才知道自己正看着哪条会话）；没给就落到全局 activeId。
	 */
	setApprovalMode(mode: ApprovalMode, conversationId?: string | null): Result;
	/** 停掉一个子代理（只停它，不动主会话那一轮） */
	interruptSubagent(runId: string): Promise<Result>;
	/** 新建 / 覆盖一个子代理模板（写 `~/.pi/agent/agents/<id>.md`） */
	saveSubagentProfile(profile: SubagentProfileView): Promise<Result>;
	/** 删掉一个用户模板（内置模板只能停用） */
	deleteSubagentProfile(profileId: string): Promise<Result>;
	/** 子代理总开关 / 并发上限 */
	setSubagentSettings(patch: Partial<SubagentSettingsView>): Promise<Result>;
	switchConversation(conversationId: string, clientId?: string): Promise<Result>;
	/** 重新读 provider 配置（models-store.json 可能被外部改动；页面刷新时顺手更新） */
	refreshProviders(): Promise<void>;
	/**
	 * 模型测速（「模型 → 测速」按钮）：交给**当前引擎**真跑一个最小回合。
	 * 当前引擎没实现（没有 `probeModel`）就回一条可读错误，而不是假装测过。
	 */
	probeModel(modelId: string): Promise<import("../engine/port.js").ModelProbeResult>;
	/** 重新扫 pi 已有的项目/会话（ADR-0021 §1）；带最小间隔，避免每次刷新都扫盘 */
	refreshPiSessions(force?: boolean): Promise<void>;
	/** 给宿主其他部分（引擎、启动流程）推一条界面提示 */
	notify(text: string, level?: Notice["level"]): void;
	/**
	 * 切智能体引擎（零重启）：项目清单 / 模型 / 能力矩阵跟着换。
	 * 回合在飞时返回 `engine.busy`（不把半截回合丢给另一个引擎）。
	 */
	setEngine(name: string): Promise<Result>;
	isBusy(): boolean;
};

export type RuntimeOptions = {
	/** 启动信息（只进日志，不进对话流） */
	onStartupInfo?: (text: string) => void;
	engine: EnginePort;
	/** 审批规则落盘（ADR-0006）：「总是允许这类」跨重启生效 */
	rules: RuleStore;
	/** 回合看门狗超时（ADR-0023）；不给就用默认 20 分钟 */
	turnTimeoutMs?: number;
	/** 「下一步」要建议的超时（默认 20 秒：超时就中断，不让隐藏回合一直挂着） */
	actionsTimeoutMs?: number;
	/** 附件上传存储（ADR-0020 §P3）：读回上传的文件；不给则附件一律失效 */
	uploadStore?: {
		read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null>;
		pathOf?: (id: string) => string;
	};
	/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（可选） */
	settings?: SettingsStore;
	/** 子代理模板目录的父目录（pi 的 agentDir，默认等于 workspace：不读真实 ~/.pi） */
	subagentAgentDir?: string;
	/** pi 已有会话的扫描器（ADR-0021 §1）；不给就不显示那一栏（可选） */
	piSessions?: () => Promise<PiProject[]>;
	/**
	 * 引擎目录（ADR-0024）：提供「有哪些引擎 / 按名字取实例 / 每个引擎的历史会话来源」。
	 * 不给就只有 `engine` 一个（最小启动），切换请求会被拒。
	 */
	engines?: EngineCatalog;
	/** 回合结束时回调（index 用它发推送通知）；failed/interrupted 决定推送文案的前缀 */
	onTurnFinished?: (info: {
		conversationId: string;
		title: string;
		workspace: string;
		failed: boolean;
		interrupted: boolean;
	}) => void;
	/** 读 provider 列表（index 注入：它同时知道内置 provider 的分组） */
	loadProviders?: () => Promise<ProviderView[]>;
	/** 两次扫描的最小间隔（默认 10s） */
	piSessionsMinIntervalMs?: number;
	workspace: string;
	/** 当前引擎名（ADR-0016）：会进快照，供界面决定提示语 */
	engineName?: string;
	/** 新会话的默认审批模式（ADR-0034）：不给就 allow（旧调用不变） */
	approvalMode?: "ask" | "allow";
	/** 引擎能力（ADR-0024 §2）；不给就当作全能（可选） */
	engineCapabilities?: import("../protocol.js").EngineCapabilities;
	emit: RuntimeEmit;
	now?: () => number;
	/** 测试注入可预测的 id；默认 `<前缀>-<序号>` */
	idSeq?: (prefix: string) => string;
	noticeDedupeMs?: number;
	maxNotices?: number;
	titleChars?: number;
};
