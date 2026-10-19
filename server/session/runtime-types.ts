/**
 * Runtime 的公开类型（ADR-0010 的拆分）：从 runtime.ts 搬出来，让那边留在 400 行护栏内。
 * 对外入口不变 —— runtime.ts 仍 `export type { Runtime, Result, RuntimeEmit }`。
 */
import type {
	AttachmentRef,
	ApprovalDecision,
	ApprovalMode,
	PiProject,
	Notice,
	ProtocolError,
	ServerEvent,
	Snapshot,
} from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import type { EnginePort } from "../engine/port.js";
import type { RuleStore } from "../approval/rules.js";
import type { SettingsStore } from "./settings.js";

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
	/** 热重载模型表（改完 provider / 模型配置后调用，免重启） */
	reloadModels(): Promise<void>;
	/** 审批模式（P4）：只在本会话内存里生效，重启回到 ask */
	setApprovalMode(mode: ApprovalMode): Result;
	switchConversation(conversationId: string): Promise<Result>;
	/** 重新扫 pi 已有的项目/会话（ADR-0021 §1）；带最小间隔，避免每次刷新都扫盘 */
	refreshPiSessions(force?: boolean): Promise<void>;
	/** 给宿主其他部分（引擎、启动流程）推一条界面提示 */
	notify(text: string, level?: Notice["level"]): void;
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
	/** 附件上传存储（ADR-0020 §P3）：读回上传的文件；不给则附件一律失效 */
	uploadStore?: {
		read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null>;
		pathOf?: (id: string) => string;
	};
	/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（单测用） */
	settings?: SettingsStore;
	/** pi 已有会话的扫描器（ADR-0021 §1）；不给就不显示那一栏（单测用） */
	piSessions?: () => Promise<PiProject[]>;
	/** 两次扫描的最小间隔（默认 10s） */
	piSessionsMinIntervalMs?: number;
	workspace: string;
	/** 当前引擎名（ADR-0016）：会进快照，供界面决定提示语 */
	engineName?: string;
	/** 引擎能力（ADR-0024 §2）；不给就当作全能（单测用） */
	engineCapabilities?: import("../protocol.js").EngineCapabilities;
	emit: RuntimeEmit;
	now?: () => number;
	/** 测试注入可预测的 id；默认 `<前缀>-<序号>` */
	idSeq?: (prefix: string) => string;
	noticeDedupeMs?: number;
	maxNotices?: number;
	titleChars?: number;
};
