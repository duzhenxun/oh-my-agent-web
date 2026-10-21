/**
 * 服务端状态与快照构造（ADR-0012）。
 *
 * 服务端持有唯一事实源；`buildSnapshot` 是纯函数：同一份 state 永远得到同一份快照，
 * 且**丢任意中间帧后，下一帧仍然正确** —— 这正是「快照可丢」能成立的原因。
 */
import {
	SNAPSHOT_MESSAGE_LIMIT,
	PROTOCOL_VERSION,
	type ApprovalMode,
	type EngineCapabilities,
	type ProviderView,
	type SessionStats,
	type ConversationMeta,
	type EngineName,
	type ModelOption,
	type PiProject,
	type ActionItem,
	type SettingsView,
	type FilesMeta,
	type Notice,
	type PendingApproval,
	type RunningState,
	type Snapshot,
	type TerminalMeta,
	type UiMessage,
} from "../protocol.js";

export type ServerState = {
	workspace: string;
	engine: EngineName;
	model: string | null;
	approvalMode: ApprovalMode;
	engineCapabilities: EngineCapabilities;
	providers: ProviderView[];
	thinkingLevel: string | null;
	thinkingLevels: string[];
	sessionStats: SessionStats | null;
	models: ModelOption[];
	piProjects: PiProject[];
	/** 会话清单的版本号：变一次 +1，用来决定「这一帧要不要顺带发清单」 */
	piProjectsVersion: number;
	settings: SettingsView;
	actions: ActionItem[];
	conversations: ConversationMeta[];
	activeId: string | null;
	messages: Record<string, UiMessage[]>;
	running: RunningState;
	/** 按会话的运行状态（并行回合用；只放 status 与开始时间，够侧栏转圈用） */
	queued: { id: string; conversationId: string; text: string }[];
	/** 已启用模型白名单（pi settings.json） */
	enabledModels: string[];
	/** 会话级缓存（ADR-0033）：多标签各看各的，不该互相覆盖 */
	statsByConversation: Record<string, SessionStats>;
	modelByConversation: Record<string, string | null>;
	thinkingByConversation: Record<string, string | null>;
	filesRootByConversation: Record<string, string>;
	runningByConversation: Record<string, { status: RunningState["status"]; turnStartedAt: number }>;
	pendingApproval: PendingApproval | null;
	/** 版本号：界面（新会话抬头）要显示 `web v0.1.0 · pi v1.3.0` */
	versions: { web: string; engine: string | null };
	notices: Notice[];
	terminal: TerminalMeta | null;
	files: FilesMeta | null;
};

export function emptyRunning(): RunningState {
	return { status: "idle", conversationId: null, turnStartedAt: null, streamingText: "", activeTool: null };
}

export function createServerState(workspace: string, engine: EngineName = "pi"): ServerState {
	return {
		workspace,
		engine,
		model: null,
		// ADR-0034：默认全部放行（提示仍然会出现在快照/悬浮牌上，用户可以随时切回「询问」）
		approvalMode: "allow",
		engineCapabilities: { approvals: true, tools: true, modelSwitch: true, thinkingLevel: true, resume: true },
		providers: [],
		thinkingLevel: null,
		thinkingLevels: [],
		sessionStats: null,
		models: [],
		piProjects: [],
		piProjectsVersion: 0,
		settings: {
			quickPhrases: [],
			quickPhrasesEnabled: true,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
			sessionPrefs: { pinned: [], archived: [] },
			defaultModels: {},
		},
		actions: [],
		conversations: [],
		activeId: null,
		messages: {},
		running: emptyRunning(),
		queued: [],
		enabledModels: [],
		statsByConversation: {},
		modelByConversation: {},
		thinkingByConversation: {},
		filesRootByConversation: {},
		runningByConversation: {},
		pendingApproval: null,
		versions: { web: "unknown", engine: null },
		notices: [],
		terminal: null,
		files: null,
	};
}

/** 换一份 pi 会话清单：顺手把版本号 +1（快照靠它决定「这一帧要不要带清单」） */
export function setPiProjects(state: ServerState, projects: PiProject[]): void {
	state.piProjects = projects;
	state.piProjectsVersion += 1;
}

export function createConversation(input: {
	id: string;
	title: string;
	workspace: string;
	now: number;
}): ConversationMeta {
	return {
		id: input.id,
		title: input.title,
		createdAt: input.now,
		updatedAt: input.now,
		workspace: input.workspace,
		messageCount: 0,
	};
}

/** 只取最近 limit 条（ADR-0012：N=100），更早的靠 hasMoreBefore 提示按需拉 */
/**
 * @param activeIdOverride 该客户端自己选中的会话（ADR-0033）：
 *   多标签 / 多设备各自看各自的会话，不再跟着服务端那个全局 activeId 跑。
 */

/**
 * 这个客户端看到的「运行状态」。
 *
 * - 没传 activeIdOverride（老路径）：直接用全局 running；
 * - 传了且正好是全局那个会话：也用全局（它带着流式正文与工具信息）；
 * - 传了但是别的会话：从 runningByConversation 里取它自己的状态，
 *   流式正文/工具不属于这条会话，留空。
 */
function runningForClient(state: ServerState, activeId: string | null, override?: string | null) {
	if (override === undefined || override === state.running.conversationId) {
		return { ...state.running, activeTool: state.running.activeTool ? { ...state.running.activeTool } : null };
	}
	const own = activeId ? state.runningByConversation[activeId] : undefined;
	return {
		status: own?.status ?? "idle",
		conversationId: activeId,
		turnStartedAt: own?.turnStartedAt ?? null,
		streamingText: "",
		activeTool: null,
	};
}

/** 会话级缓存里取该会话的值；没有记录就回落到全局那份 */
function pickPerConversation(
	cache: Record<string, string | null>,
	activeId: string | null,
	fallback: string | null,
): string | null {
	if (!activeId) return fallback;
	return Object.hasOwn(cache, activeId) ? cache[activeId] : fallback;
}

export type BuildSnapshotOptions = {
	/**
	 * 要不要带 pi 会话清单（默认带）。
	 * 不带时快照里没有 `piProjects` 字段 —— 客户端沿用上一份（见 protocol.ts 的说明）。
	 */
	includeProjects?: boolean;
};

export function buildSnapshot(
	state: ServerState,
	limit = SNAPSHOT_MESSAGE_LIMIT,
	activeIdOverride?: string | null,
	options: BuildSnapshotOptions = {},
): Snapshot {
	const activeId = activeIdOverride === undefined ? state.activeId : activeIdOverride;
	const all = activeId ? (state.messages[activeId] ?? []) : [];
	const messages = all.length > limit ? all.slice(all.length - limit) : all;
	return {
		protocolVersion: PROTOCOL_VERSION,
		engine: state.engine,
		model: pickPerConversation(state.modelByConversation, activeId, state.model),
		approvalMode: state.approvalMode,
		engineCapabilities: { ...state.engineCapabilities },
		providers: state.providers.map((provider) => ({
			...provider,
			models: provider.models.map((model) => ({ ...model })),
		})),
		thinkingLevel: pickPerConversation(state.thinkingByConversation, activeId, state.thinkingLevel),
		thinkingLevels: [...state.thinkingLevels],
		sessionStats: state.sessionStats ? { ...state.sessionStats } : null,
		models: state.models.map((model) => ({ ...model })),
		actions: state.actions.map((action) => ({ ...action })),
		settings: {
			quickPhrases: [...state.settings.quickPhrases],
			quickPhrasesEnabled: state.settings.quickPhrasesEnabled,
			templates: state.settings.templates.map((template) => ({ ...template })),
			projectPrefs: {
				order: [...state.settings.projectPrefs.order],
				pinned: [...state.settings.projectPrefs.pinned],
				aliases: { ...state.settings.projectPrefs.aliases },
			},
			defaultModels: { ...state.settings.defaultModels },
			sessionPrefs: {
				pinned: [...state.settings.sessionPrefs.pinned],
				archived: [...state.settings.sessionPrefs.archived],
			},
		},
		...(options.includeProjects === false
			? {}
			: {
					piProjects: state.piProjects.map((project) => ({
						...project,
						sessions: project.sessions.map((session) => ({ ...session })),
					})),
				}),
		conversations: state.conversations.map((conversation) => ({ ...conversation })),
		active: {
			conversationId: activeId,
			messages: messages.map((message) => ({ ...message, blocks: message.blocks.map((block) => ({ ...block })) })),
			hasMoreBefore: all.length > messages.length,
		},
		// running 也要按客户端的会话算：否则别人在跑时，你在看的会话既不出「引导/排队」，
		// 也看不到 agent 在工作（但状态栏又显示「工作中」）—— A 方案落地后的连带问题
		running: runningForClient(state, activeId, activeIdOverride),
		queued: state.queued.map((item) => ({ ...item })),
		enabledModels: [...state.enabledModels],
		runningByConversation: { ...state.runningByConversation },
		pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
		versions: { ...state.versions },
		terminal: state.terminal ? { ...state.terminal } : null,
		files: (() => {
			const root = activeId ? state.filesRootByConversation[activeId] : undefined;
			if (!root) return state.files ? { ...state.files } : null;
			return { root, treeVersion: state.files?.treeVersion ?? 0 };
		})(),
		notices: state.notices.map((notice) => ({ ...notice })),
	};
}

/** 快照体积（字节）—— ADR-0012 的体积护栏用它判断是否需要减小 N */
export function snapshotBytes(snapshot: Snapshot): number {
	return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}
