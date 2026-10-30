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
	type EngineOption,
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
	type QueuedMode,
	type RunningState,
	type Snapshot,
	type SubagentProfileView,
	type SubagentRunView,
	type SubagentSettingsView,
	type TerminalMeta,
	type UiMessage,
} from "../protocol.js";
import { isOutdated } from "../util/upstream-version.js";

export type ServerState = {
	workspace: string;
	engine: EngineName;
	/** 可切换的引擎清单（注册表给的，不随会话变） */
	engines: EngineOption[];
	model: string | null;
	/**
	 * 审批模式的**兜底值**：没有选中会话时用它（也当「没单独设过的会话」的默认）。
	 * 会话自己设过的模式在 `approvalByConversation` 里 —— 审批是「这一步要不要问」，
	 * 跟模型 / 思考强度一样属于当前这一条会话，不能拿一份全局值糊到每个会话上。
	 */
	approvalMode: ApprovalMode;
	/** 按会话存的审批模式（ADR-0034 的默认 allow 不变，只是改成各会话各记一份） */
	approvalByConversation: Record<string, ApprovalMode>;
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
	/**
	 * 「下一步」建议（ADR-0022）：**按会话存**。
	 *
	 * 以前是一份全局数组：本项目支持跨会话并行回合，A 会话的回合在你切到 B 之后结束时，
	 * 会把 A 的建议写进全局 → B 的界面上冒出 A 的建议（用户报的就是这个）。
	 * 而且因为只能「切走就清」，切回来还丢了。
	 */
	actionsByConversation: Record<string, ActionItem[]>;
	conversations: ConversationMeta[];
	activeId: string | null;
	messages: Record<string, UiMessage[]>;
	running: RunningState;
	/** 按会话的运行状态（并行回合用；只放 status 与开始时间，够侧栏转圈用） */
	queued: { id: string; conversationId: string; text: string; mode: QueuedMode }[];
	/** 子代理运行记录（按会话分组；面板只看当前会话那一份） */
	subagentsByConversation: Record<string, SubagentRunView[]>;
	/** 子代理模板（内置 + `~/.pi/agent/agents/*.md`）；空数组 = 当前引擎没有子代理 */
	subagentProfiles: SubagentProfileView[];
	/** 子代理总开关与并发上限 */
	subagentSettings: SubagentSettingsView;
	/** 已启用模型白名单（pi settings.json） */
	enabledModels: string[];
	/** 会话级缓存（ADR-0033）：多标签各看各的，不该互相覆盖 */
	statsByConversation: Record<string, SessionStats>;
	modelByConversation: Record<string, string | null>;
	thinkingByConversation: Record<string, string | null>;
	filesRootByConversation: Record<string, string>;
	runningByConversation: Record<string, { status: RunningState["status"]; turnStartedAt: number }>;
	pendingApproval: PendingApproval | null;
	/**
	 * 版本号：界面（新会话抬头）要显示 `web v0.1.0 · pi v1.3.0`。
	 * `latest` 是上游最新版本（服务端查的，查不到为 null）；`outdated` 由它算出来，见 buildSnapshot。
	 */
	versions: { web: string; engine: string | null; latest: string | null };
	/**
	 * 每个引擎**各自的**版本号（切换面板那一行右上角的 `v0.16.2`）：
	 * 当前引擎用握手给的最准值，其余引擎靠一次轻量探测（见 engine/engine-versions.ts）。
	 * 只在服务端内部用：发出去的快照里它已经贴到 `engines[].version` 上了。
	 */
	engineVersions: Record<string, string | null>;
	notices: Notice[];
	terminal: TerminalMeta | null;
	files: FilesMeta | null;
};

export function emptyRunning(): RunningState {
	return {
		status: "idle",
		conversationId: null,
		turnStartedAt: null,
		streamingText: "",
		activeTool: null,
		retrying: null,
	};
}

export function createServerState(
	workspace: string,
	engine: EngineName = "pi",
	/** 新会话的默认审批模式（ADR-0034）：从配置来，默认 allow */
	approvalMode: ApprovalMode = "allow",
): ServerState {
	return {
		workspace,
		engine,
		engines: [],
		model: null,
		// ADR-0034：默认全部放行（提示仍然会出现在快照/悬浮牌上，用户可以随时切回「询问」）
		// 想改默认值：AGENT_WEB_APPROVAL_MODE=ask（见 util/env.ts）
		approvalMode,
		approvalByConversation: {},
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
			sessionPrefs: { pinned: [], archived: [], order: [] },
			defaultModels: {},
			thinkCount: 5,
			thinkTimeoutSec: 20,
		},
		actionsByConversation: {},
		conversations: [],
		activeId: null,
		messages: {},
		running: emptyRunning(),
		queued: [],
		subagentsByConversation: {},
		subagentProfiles: [],
		subagentSettings: { enabled: true, concurrency: 4 },
		enabledModels: [],
		statsByConversation: {},
		modelByConversation: {},
		thinkingByConversation: {},
		filesRootByConversation: {},
		runningByConversation: {},
		pendingApproval: null,
		versions: { web: "unknown", engine: null, latest: null },
		engineVersions: {},
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

/** 会话元数据刷新（内存态）：updatedAt / messageCount 跟着消息走 */
export function touchConversationIn(
	state: ServerState,
	conversationId: string,
	now: number,
	patch: { title?: string } = {},
): void {
	state.conversations = state.conversations.map((conversation) =>
		conversation.id === conversationId
			? {
					...conversation,
					...patch,
					updatedAt: now,
					messageCount: state.messages[conversationId]?.length ?? conversation.messageCount,
				}
			: conversation,
	);
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
		return {
			...state.running,
			activeTool: state.running.activeTool ? { ...state.running.activeTool } : null,
			retrying: state.running.retrying ? { ...state.running.retrying } : null,
		};
	}
	const own = activeId ? state.runningByConversation[activeId] : undefined;
	return {
		status: own?.status ?? "idle",
		conversationId: activeId,
		turnStartedAt: own?.turnStartedAt ?? null,
		streamingText: "",
		activeTool: null,
		// 「正在重试」属于真正在跑的那条会话，别人的快照里不该出现
		retrying: null,
	};
}

/**
 * 这个会话的审批模式：自己设过就用自己那份，没设过回落到兜底值（默认 allow）。
 *
 * 审批模式跟模型 / 思考强度一样是**会话级**的：切到另一个会话看到的是那个会话自己的选择，
 * 在 A 会话开的「全部放行」不会顺带把 B 会话也放开。
 */
export function approvalModeOf(state: ServerState, conversationId: string | null): ApprovalMode {
	const own = conversationId ? state.approvalByConversation[conversationId] : undefined;
	return own ?? state.approvalMode;
}

/** 写某个会话的审批模式；没有会话（还没开聊）时改的是兜底值 */
export function setApprovalModeOf(state: ServerState, conversationId: string | null, mode: ApprovalMode): void {
	if (conversationId) state.approvalByConversation = { ...state.approvalByConversation, [conversationId]: mode };
	else state.approvalMode = mode;
}

/** 会话没了就把它的审批模式一起丢掉（别攒一堆指向不存在会话的记录） */
export function forgetApprovalModeOf(state: ServerState, conversationId: string): void {
	if (!Object.hasOwn(state.approvalByConversation, conversationId)) return;
	const { [conversationId]: _gone, ...rest } = state.approvalByConversation;
	state.approvalByConversation = rest;
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

/**
 * 取某个会话的建议（没有就是空数组）。
 *
 * 一定要传**当前客户端看到的那条会话**：`buildSnapshot` 的 activeId 是按客户端覆盖的，
 * 拿全局 `state.activeId` 会在多标签/多设备时串会话。
 */
export function actionsOf(state: ServerState, conversationId: string | null): ActionItem[] {
	if (conversationId === null) return [];
	return state.actionsByConversation[conversationId] ?? [];
}

/** 写某个会话的建议；空数组 = 删掉这条记录（不留空壳，快照也不会带上） */
export function setActionsOf(state: ServerState, conversationId: string | null, actions: ActionItem[]): void {
	if (conversationId === null) return;
	if (actions.length === 0) delete state.actionsByConversation[conversationId];
	else state.actionsByConversation[conversationId] = actions;
}

type BuildSnapshotOptions = {
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
		engines: state.engines.map((option) => ({ ...option, capabilities: { ...option.capabilities } })),
		model: pickPerConversation(state.modelByConversation, activeId, state.model),
		approvalMode: approvalModeOf(state, activeId),
		engineCapabilities: { ...state.engineCapabilities },
		providers: state.providers.map((provider) => ({
			...provider,
			models: provider.models.map((model) => ({ ...model })),
		})),
		thinkingLevel: pickPerConversation(state.thinkingByConversation, activeId, state.thinkingLevel),
		thinkingLevels: [...state.thinkingLevels],
		// 统计同样按会话取：`state.sessionStats` 只跟服务端那个全局 activeId 走，
		// 多标签 / 挂着后台会话时会把这个会话的上下文用量算成别人的
		sessionStats: activeId
			? (state.statsByConversation[activeId] ?? null)
			: state.sessionStats
				? { ...state.sessionStats }
				: null,
		models: state.models.map((model) => ({ ...model })),
		actions: actionsOf(state, activeId).map((action) => ({ ...action })),
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
				order: [...state.settings.sessionPrefs.order],
			},
			thinkCount: state.settings.thinkCount,
			thinkTimeoutSec: state.settings.thinkTimeoutSec,
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
		// running 也要按客户端的会话算：否则别人在跑时，你在看的会话既不出「插队/排队」，
		// 也看不到 agent 在工作（但状态栏又显示「工作中」）—— A 方案落地后的连带问题
		running: runningForClient(state, activeId, activeIdOverride),
		queued: state.queued.map((item) => ({ ...item })),
		subagents: (activeId ? (state.subagentsByConversation[activeId] ?? []) : []).map((run) => ({
			...run,
			...(run.tokens ? { tokens: { ...run.tokens } } : {}),
		})),
		subagentProfiles: state.subagentProfiles.map((profile) => ({ ...profile, tools: [...profile.tools] })),
		subagentSettings: { ...state.subagentSettings },
		enabledModels: [...state.enabledModels],
		runningByConversation: { ...state.runningByConversation },
		pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
		// 标不标红在这里算：快照是纯函数，界面拿到的就是一个结论，不用自己比版本号
		versions: {
			web: state.versions.web,
			engine: state.versions.engine,
			latest: state.versions.latest,
			outdated: isOutdated(state.versions.latest, state.versions.web),
		},
		terminal: state.terminal ? { ...state.terminal } : null,
		files: (() => {
			const root = activeId ? state.filesRootByConversation[activeId] : undefined;
			if (!root) return state.files ? { ...state.files } : null;
			return { root, treeVersion: state.files?.treeVersion ?? 0 };
		})(),
		notices: state.notices.map((notice) => ({ ...notice })),
	};
}
