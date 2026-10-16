/**
 * 引擎端口（ADR-0003）。
 *
 * 这是本项目**唯一**允许 import 引擎 SDK 的边界（守卫 `check-engine-imports.mjs` 强制）：
 *   - 业务代码（session / snapshot / index / web）只见这里的类型；
 *   - 换引擎 = 换掉这份接口的实现（`pi-sdk.ts`），而不是全仓重写。
 *
 * 端口只暴露 5 个动作（ADR-0003 §决策），动作数上限 8 —— 超了说明边界漏了，要审计。
 */
import type { ApprovalDecision } from "../protocol.js";

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
	| { type: "tool_start"; toolCallId: string; name: string; argsSummary: string }
	| {
			type: "tool_end";
			toolCallId: string;
			status: "ok" | "failed";
			output: string;
			exitCode?: number;
	  }
	| { type: "turn_end"; reason: "done" | "interrupted" | "error" }
	| { type: "error"; code: string; message: string };

/** 引擎侧的转录（宿主自己决定怎么映射成 UiMessage） */
export type EngineMessage = { role: "user" | "assistant"; text: string; ts: number };

export type EngineSessionOptions = {
	sessionId: string;
	/** 工作区根（ADR-0006 的路径约束在宿主侧强制，引擎只是被告知） */
	workspace: string;
	/**
	 * 会话已有历史的纯文本形式（宿主的事实源是自家 JSONL，引擎侧是空的）。
	 * **不传 = 模型会失忆**：从磁盘恢复的会话再接着聊时，它看不到之前说过什么。
	 */
	history?: EngineMessage[];
};

export type EnginePort = {
	createSession(options: EngineSessionOptions): Promise<void>;
	/** 发一轮输入；事件通过 onEvent 推给宿主；Promise 在回合结束时 resolve */
	sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void): Promise<void>;
	interrupt(sessionId: string): Promise<void>;
	readTranscript(sessionId: string): Promise<EngineMessage[]>;
	/** 危险操作前引擎会调用它；宿主负责弹给用户并等待决定（ADR-0006 审批三态） */
	setApprovalHandler(handler: ApprovalHandler): void;
	/** 当前模型（用于界面显示；取不到返回 null） */
	currentModel?(sessionId: string): Promise<{ provider: string; model: string } | null>;
};
