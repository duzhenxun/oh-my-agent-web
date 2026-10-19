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

/** 模型条目（ADR-0020 §P2）：id 是 `provider/modelId`，label 给人看 */
export type EngineModelInfo = { id: string; label: string; current?: boolean };

export type EngineSessionOptions = {
	sessionId: string;
	/** 工作区根（ADR-0006 的路径约束在宿主侧强制，引擎只是被告知） */
	workspace: string;
};

/** 打开一个已经存在的会话（ADR-0021 §2）：上下文由会话文件本身提供 */
export type EngineOpenOptions = {
	sessionId: string;
	/** pi 会话文件路径（`~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl`） */
	sessionPath: string;
};

export type EnginePort = {
	/** 新建会话（ADR-0021 §2 起返回会话文件路径，供宿主列表用） */
	createSession(options: EngineSessionOptions): Promise<{ sessionPath: string | null }>;
	/** 打开已有会话（ADR-0021 §2）：上下文来自会话自己的转录，不需要注入历史 */
	openSession(options: EngineOpenOptions): Promise<void>;
	/** 发一轮输入；事件通过 onEvent 推给宿主；Promise 在回合结束时 resolve */
	sendMessage(
		sessionId: string,
		text: string,
		onEvent: (event: EngineEvent) => void,
		/** 图片附件（ADR-0020 §P3）：base64 + mime，交给模型做视觉注入 */
		options?: { images?: Array<{ data: string; mimeType: string }> },
	): Promise<void>;
	interrupt(sessionId: string): Promise<void>;
	/** 关掉一个引擎会话（LRU 回收：同时打开太多会带来多次资源扫描） */
	closeSession?(sessionId: string): Promise<void>;
	readTranscript(sessionId: string): Promise<EngineMessage[]>;
	/** 读转录并映射成界面消息（text / tool 块）——侧栏与对话区都靠它 */
	readUiMessages(sessionId: string): Promise<UiMessage[]>;
	/** 危险操作前引擎会调用它；宿主负责弹给用户并等待决定（ADR-0006 审批三态） */
	setApprovalHandler(handler: ApprovalHandler): void;
	/** 可用模型列表（ADR-0020 §P2）：`provider/modelId` + 给人看的标签 */
	listModels?(sessionId?: string): Promise<EngineModelInfo[]>;
	/** 切换某个会话的模型（写进会话文件，续聊时模型不变） */
	switchModel?(sessionId: string, modelId: string): Promise<boolean>;
	/** 这个会话可选的思考强度（模型不支持推理时返回空数组 → 界面隐藏该控件） */
	listThinkingLevels?(sessionId?: string): Promise<string[]>;
	/** 当前思考强度；不支持时为 null */
	getThinkingLevel?(sessionId?: string): Promise<string | null>;
	/** 设置思考强度；返回 false = 这个档位该模型不支持 */
	setThinkingLevel?(sessionId: string, level: string): Promise<boolean>;
	/** 当前模型（用于界面显示；取不到返回 null） */
	currentModel?(sessionId: string): Promise<{ provider: string; model: string } | null>;
};
