/**
 * 服务端状态与快照构造（ADR-0012）。
 *
 * 服务端持有唯一事实源；`buildSnapshot` 是纯函数：同一份 state 永远得到同一份快照，
 * 且**丢任意中间帧后，下一帧仍然正确** —— 这正是「快照可丢」能成立的原因。
 */
import {
	SNAPSHOT_MESSAGE_LIMIT,
	PROTOCOL_VERSION,
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
	models: ModelOption[];
	piProjects: PiProject[];
	settings: SettingsView;
	actions: ActionItem[];
	conversations: ConversationMeta[];
	activeId: string | null;
	messages: Record<string, UiMessage[]>;
	running: RunningState;
	pendingApproval: PendingApproval | null;
	notices: Notice[];
	terminal: TerminalMeta | null;
	files: FilesMeta | null;
};

export function emptyRunning(): RunningState {
	return { status: "idle", turnStartedAt: null, streamingText: "", activeTool: null };
}

export function createServerState(workspace: string, engine: EngineName = "pi"): ServerState {
	return {
		workspace,
		engine,
		model: null,
		models: [],
		piProjects: [],
		settings: { quickPhrases: [], quickPhrasesEnabled: true },
		actions: [],
		conversations: [],
		activeId: null,
		messages: {},
		running: emptyRunning(),
		pendingApproval: null,
		notices: [],
		terminal: null,
		files: null,
	};
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
export function buildSnapshot(state: ServerState, limit = SNAPSHOT_MESSAGE_LIMIT): Snapshot {
	const all = state.activeId ? (state.messages[state.activeId] ?? []) : [];
	const messages = all.length > limit ? all.slice(all.length - limit) : all;
	return {
		protocolVersion: PROTOCOL_VERSION,
		engine: state.engine,
		model: state.model,
		models: state.models.map((model) => ({ ...model })),
		actions: state.actions.map((action) => ({ ...action })),
		settings: {
			quickPhrases: [...state.settings.quickPhrases],
			quickPhrasesEnabled: state.settings.quickPhrasesEnabled,
		},
		piProjects: state.piProjects.map((project) => ({
			...project,
			sessions: project.sessions.map((session) => ({ ...session })),
		})),
		conversations: state.conversations.map((conversation) => ({ ...conversation })),
		active: {
			conversationId: state.activeId,
			messages: messages.map((message) => ({ ...message, blocks: message.blocks.map((block) => ({ ...block })) })),
			hasMoreBefore: all.length > messages.length,
		},
		running: { ...state.running, activeTool: state.running.activeTool ? { ...state.running.activeTool } : null },
		pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
		terminal: state.terminal ? { ...state.terminal } : null,
		files: state.files ? { ...state.files } : null,
		notices: state.notices.map((notice) => ({ ...notice })),
	};
}

/** 快照体积（字节）—— ADR-0012 的体积护栏用它判断是否需要减小 N */
export function snapshotBytes(snapshot: Snapshot): number {
	return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}
