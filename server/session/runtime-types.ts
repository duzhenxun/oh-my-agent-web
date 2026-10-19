/**
 * Runtime 的公开类型（ADR-0010 的拆分）：从 runtime.ts 搬出来，让那边留在 400 行护栏内。
 * 对外入口不变 —— runtime.ts 仍 `export type { Runtime, Result, RuntimeEmit }`。
 */
import type {
	AttachmentRef,
	ApprovalDecision,
	ApprovalMode,
	Notice,
	ProtocolError,
	ServerEvent,
	Snapshot,
} from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";

export type RuntimeEmit = {
	snapshot(snapshot: Snapshot): void;
	event(event: ServerEvent): void;
};
export type Result = { ok: true } | { ok: false; error: ProtocolError };
export type Runtime = {
	init(): Promise<void>;
	snapshot(): Snapshot;
	state(): ServerState;
	sendMessage(text: string, attachments?: AttachmentRef[]): Promise<Result>;
	interrupt(): Promise<Result>;
	approve(requestId: string, decision: ApprovalDecision): Result;
	newConversation(workspace?: string): Promise<Result>;
	/** 改客户端设置（ADR-0020 §P1）：归一化 → 落盘 → 推快照 */
	applySettings(patch: unknown): Promise<Result>;
	/** 切换当前会话的模型（ADR-0020 §P2） */
	setModel(modelId: string): Promise<Result>;
	/** 思考强度（P4）：档位由引擎给，不支持时界面隐藏控件 */
	setThinkingLevel(level: string): Promise<Result>;
	/** 只推一帧快照（不制造提示条） */
	pushSnapshot(): void;
	/** 审批模式（P4）：只在本会话内存里生效，重启回到 ask */
	setApprovalMode(mode: ApprovalMode): Result;
	switchConversation(conversationId: string): Promise<Result>;
	/** 重新扫 pi 已有的项目/会话（ADR-0021 §1）；带最小间隔，避免每次刷新都扫盘 */
	refreshPiSessions(force?: boolean): Promise<void>;
	/** 给宿主其他部分（引擎、启动流程）推一条界面提示 */
	notify(text: string, level?: Notice["level"]): void;
	isBusy(): boolean;
};
