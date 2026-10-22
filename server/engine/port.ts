/**
 * 引擎端口（ADR-0003）。
 *
 * 这是本项目**唯一**允许 import 引擎 SDK 的边界（守卫 `check-engine-imports.mjs` 强制）：
 *   - 业务代码（session / snapshot / index / web）只见这里的类型；
 *   - 换引擎 = 换掉这份接口的实现（`pi-sdk.ts`），而不是全仓重写。
 *
 * 端口只暴露 5 个动作（ADR-0003 §决策），动作数上限 8 —— 超了说明边界漏了，要审计。
 */
import type { ApprovalDecision, UiMessage } from "../protocol.js";

export type ApprovalRequest = {
	toolName: string;
	argsSummary: string;
	/** 机器用的稳定键（`bash|npm`、`write|/repo/docs`）：规则匹配靠它 */
	scopeKey: string;
	/** 「这类」的可读描述（命令名 / 目标目录），用于界面与「总是允许这类」 */
	scopeHint: string;
	riskNote: string;
};

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** 引擎发出的原子事件（宿主负责翻译成 UI 状态与协议事件） */
export type EngineEvent =
	| { type: "text_delta"; text: string }
	/** 模型的"思考"增量（reasoning）：单独一类，界面上折叠展示 */
	| { type: "thinking_delta"; text: string }
	| {
			type: "tool_start";
			toolCallId: string;
			name: string;
			argsSummary: string;
			/** 完整参数（给「展开看全 + 复制」）；与摘要一样时省略 */
			argsFull?: string;
	  }
	| {
			type: "tool_end";
			toolCallId: string;
			status: "ok" | "failed";
			output: string;
			exitCode?: number;
	  }
	/**
	 * 一次**模型调用**的 token 用量。
	 *
	 * `final: false` = 同一次调用的过程值（SDK 在 message_update 上带的那份），
	 * **不能进合计** —— 否则和随后 message_end 的最终值重复计费。
	 * 一轮里可能有很多次模型调用（每次工具调用前后各一次），宿主按 final 的那份求和。
	 */
	| {
			type: "usage";
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost?: number;
			final?: boolean;
	  }
	/** 这条回复用的模型（`provider/model`）：界面按它显示，别用「当前选择的模型」 */
	| { type: "model"; model: string }
	| { type: "turn_end"; reason: "done" | "interrupted" | "error" }
	| { type: "error"; code: string; message: string };

/** 引擎侧的转录（宿主自己决定怎么映射成 UiMessage） */
export type EngineMessage = { role: "user" | "assistant"; text: string; ts: number };

/** 模型条目（ADR-0020 §P2）：id 是 `provider/modelId`，label 给人看 */
export type EngineModelInfo = { id: string; label: string; current?: boolean };

export type EngineSessionOptions = {
	sessionId: string;
	/** 工作区根（ADR-0006 的路径约束在宿主侧强制，引擎只是被告知） */
	workspace: string;
};

/**
 * 打开一个已经存在的会话（ADR-0021 §2）：上下文由会话自己的存储提供。
 *
 * 两种句柄二选一，由引擎自己解释：
 *   - `engineSessionId`：引擎自己的 id（codex 的 threadId）；
 *   - `sessionPath`：会话文件路径（pi 的 `~/.pi/agent/sessions/...`）。
 */
export type EngineOpenOptions = {
	sessionId: string;
	engineSessionId?: string;
	sessionPath?: string;
	/** 会话的工作目录（dsh 的 `session/resume` 必填；pi 不需要，忽略即可） */
	cwd?: string;
};

export type EnginePort = {
	/** 引擎自己的版本号（界面上要显示 `pi v1.3.0` 这种）；拿不到返回 null */
	version?: () => string | null;
	/** 新建会话（ADR-0021 §2 起返回会话文件路径，供宿主列表用） */
	createSession(options: EngineSessionOptions): Promise<{ sessionPath: string | null; engineSessionId?: string }>;
	/** 打开已有会话（ADR-0021 §2）：上下文来自会话自己的转录，不需要注入历史 */
	openSession(options: EngineOpenOptions): Promise<void>;
	/** 发一轮输入；事件通过 onEvent 推给宿主；Promise 在回合结束时 resolve */
	sendMessage(
		sessionId: string,
		text: string,
		onEvent: (event: EngineEvent) => void,
		/** 图片附件（ADR-0020 §P3）：base64 + mime，交给模型做视觉注入 */
		options?: {
			images?: Array<{ data: string; mimeType: string }>;
			/** 回合进行中怎么处理这条新消息（pi 的 streamingBehavior）：steer=打断当前轮插入，followUp=等这轮结束 */
			streamingBehavior?: "steer" | "followUp";
		},
	): Promise<void>;
	interrupt(sessionId: string): Promise<void>;
	/** 关掉一个引擎会话（LRU 回收：同时打开太多会带来多次资源扫描） */
	closeSession?(sessionId: string): Promise<void>;
	/**
	 * 「这个会话暂时不看了」：释放**外部资源/写锁**，但保留能重新打开所需的状态。
	 *
	 * 为什么需要它：codex 的 thread 一被 resume 就持有 writer lock，用户在 Codex 桌面端
	 * 打开同一条会话会被我们挡住；切走会话时主动放开，桌面端立刻能用。
	 * pi 不需要（它没有锁）→ 不实现即无操作。
	 */
	parkSession?(sessionId: string): Promise<void>;
	/**
	 * 换引擎 / 退出时收掉引擎占用的外部资源（codex：关掉 app-server 子进程，顺带释放它的全部写锁）。
	 * 之后这个引擎再被切回来会**懒启动**，不需要重新构造实例。
	 */
	dispose?(): void | Promise<void>;
	readTranscript(sessionId: string): Promise<EngineMessage[]>;
	/**
	 * 改会话显示名：写进**引擎自己的会话存储**（pi 追加 `session_info` / codex `thread/name/set`），
	 * 不另存一份本地变量 —— 这样 CLI 里看到的也是这个名字。
	 * `handle` 是引擎自己的会话句柄：pi = 文件路径，codex = threadId。
	 */
	renameSession?: (handle: string, name: string) => Promise<void>;
	/** 删除会话（引擎原生删除）；没有这个能力时宿主退回到「把文件改名」 */
	deleteSession?: (handle: string) => Promise<void>;
	/** 读转录并映射成界面消息（text / tool 块）——侧栏与对话区都靠它 */
	readUiMessages(sessionId: string): Promise<UiMessage[]>;
	/** 危险操作前引擎会调用它；宿主负责弹给用户并等待决定（ADR-0006 审批三态） */
	setApprovalHandler(handler: ApprovalHandler): void;
	/** 可用模型列表（ADR-0020 §P2）：`provider/modelId` + 给人看的标签 */
	listModels?(sessionId?: string): Promise<EngineModelInfo[]>;
	/**
	 * 预热：有的引擎要「有一个会话」才拿得到模型表（pi 的 modelRuntime 挂在会话上）。
	 * 调一次之后 `listModels()` 在**没打开任何会话**时也能给结果，界面启动即可列全 provider。
	 */
	prewarm?(): Promise<void>;
	/** 切换某个会话的模型（写进会话文件，续聊时模型不变） */
	switchModel?(sessionId: string, modelId: string): Promise<boolean>;
	/** 这个会话可选的思考强度（模型不支持推理时返回空数组 → 界面隐藏该控件） */
	listThinkingLevels?(sessionId?: string): Promise<string[]>;
	/** 当前思考强度；不支持时为 null */
	getThinkingLevel?(sessionId?: string): Promise<string | null>;
	/** 重新加载模型表（ADR-0025 §4）：改完 provider / 模型配置后调用，免得重启 */
	reloadModels?(): Promise<void>;
	/** 设置思考强度；返回 false = 这个档位该模型不支持 */
	setThinkingLevel?(sessionId: string, level: string): Promise<boolean>;
	/**
	 * 最近一次「可预期失败」的原因（切模型 / 切思考档位）：
	 * 界面用它把 `model.switch_failed` 变成一条能看懂的话，而不是只丢一个模型 id。
	 * 成功时清空。
	 */
	lastError?: () => string | null;
	/**
	 * 该会话的用量统计（宿主右侧「会话信息」用）。
	 * 有的引擎统计在会话存储里（dsh 的日志/投影），有的由宿主自己算（pi 读 JSONL）。
	 * 返回 null = 这个引擎不提供，宿主退回自己的算法。
	 */
	sessionStats?(sessionId: string): Promise<import("../protocol.js").SessionStats | null>;
	/** 当前模型（用于界面显示；取不到返回 null） */
	currentModel?(sessionId: string): Promise<{ provider: string; model: string } | null>;
	/** 会话**持久化**的模型（会话文件里最后一次 model_change）：续聊、历史会话都以它为准 */
	sessionModel?(sessionId: string): Promise<{ provider: string; model: string } | null>;
};
