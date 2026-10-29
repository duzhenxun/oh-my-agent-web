/**
 * 引擎端口（ADR-0003）。
 *
 * 这是本项目**唯一**允许 import 引擎 SDK 的边界（守卫 `check-engine-imports.mjs` 强制）：
 *   - 业务代码（session / snapshot / index / web）只见这里的类型；
 *   - 换引擎 = 换掉这份接口的实现（`pi-sdk.ts`），而不是全仓重写。
 *
 * 端口只暴露 5 个动作（ADR-0003 §决策），动作数上限 8 —— 超了说明边界漏了，要审计。
 */
import type { ApprovalDecision, SubagentRunView, UiMessage } from "../protocol.js";

export type ApprovalRequest = {
	/**
	 * 这个审批是**哪个会话**要的（引擎知道就一定要填）。
	 *
	 * 用途很具体：回合收尾要按会话收掉悬着的审批。以前不知道归属、只能全局收，
	 * 结果 A 会话等你审批时，B 会话一回合一结束就把 A 的审批静默拒掉了。
	 * 填不出来的引擎（拿不到会话上下文）留空，宿主会保守处理（见 approval-bridge）。
	 */
	conversationId?: string;
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

/**
 * 引擎**目录里**的 provider（不等于「已鉴权」）。
 *
 * 为什么要它：`listModels()` 只回「现在能用」的模型，没配 key 的 provider 根本不出现 ——
 * 于是「粘一把 key 就能用」这件事在界面上无处可做（只能自己去手写一个自定义 provider）。
 * 这里把引擎自带的目录倒出来，宿主就能把它们列在「官方内置服务商」里等用户填 key。
 */
export type EngineProviderCatalogEntry = {
	provider: string;
	name: string;
	/** 目录里写死的端点（有的 provider 端点挂在模型上，这里从模型上取一个） */
	baseUrl?: string;
	/** 目录里声明的 api 形态（同样可能只在模型上）：填表单时预填用 */
	api?: string;
	/**
	 * 逐模型的协议 / 端点。同一个 provider 可能混用多种协议（OpenCode Go：
	 * anthropic / openai / gemini 三种），逐模型试连必须按模型自己的走。
	 */
	models?: { id: string; api?: string; baseUrl?: string }[];
	/** 目录里声明的模型数量：未鉴权拿不到清单，但能说清「填了 key 有多少可用」 */
	modelCount: number;
	/** 只支持订阅登录（如 OpenAI Codex legacy）：填 key 没用，不往「填 key 就能用」里放 */
	oauthOnly?: boolean;
	/** 还需要端点 / 云凭证（bedrock、vertex、azure、cloudflare）：只填 key 跑不起来 */
	needsExtraConfig?: boolean;
};

export type EngineSessionOptions = {
	sessionId: string;
	/** 工作区根（ADR-0006 的路径约束在宿主侧强制，引擎只是被告知） */
	workspace: string;
	/**
	 * 临时会话：会话只存在内存里，**不落盘**（不建文件、不进历史）。
	 * `persistSession` 才能把它变成一个真正的会话文件。不支持就报错（宿主靠能力位提前拦住）。
	 */
	ephemeral?: boolean;
	/**
	 * 派生：新会话的初始历史 = 源会话从根到 `leafId` 的那条路径（源会话一个字不动）。
	 *
	 * 为什么由引擎做：裁剪得按**引擎自己的会话树**走（entry 的 parentId 关系），
	 * 宿主手里只有映射好的界面消息，拿不到分叉所需的 entry 结构。
	 */
	fork?: { sourceSessionId: string; leafId: string };
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

// ---------------------------------------------------------------------------
// 子代理（多开、可管理）：引擎侧的委派能力
//
// 为什么放在引擎侧：子代理就是「另一个 SDK 会话」，只有引擎允许 import SDK。
// 宿主只管「展示谁在跑、停掉它、改模板」—— 它拿到的是 protocol 里的 SubagentRunView。
// ---------------------------------------------------------------------------

/** 一次委派的入参（宿主 → 引擎） */
export type SubagentRequest = {
	/** 归属哪个宿主会话（面板按它分组） */
	conversationId: string;
	/** 子代理在哪个目录干活（= 父会话的工作区） */
	workspace: string;
	/** 父会话文件路径：子会话紧挨着它归档，便于事后在 pi 里找到 */
	parentSessionPath: string | null;
	/** 模板（面板里那一格） */
	profile: {
		id: string;
		label: string;
		systemPrompt: string;
		tools: string[];
		model?: string;
		thinking?: string;
		maxTurns?: number;
	};
	/** 模型的 description 参数：面板上「让它干什么」那一行 */
	description: string;
	/** 完整任务原文 */
	task: string;
};

export type SubagentEnginePort = {
	/** 超并发就排队；立即返回运行 id（面板马上就能显示「排队中」） */
	start(request: SubagentRequest): Promise<{ id: string }>;
	/** 停掉一个在跑 / 在排队的子代理（只停它） */
	interrupt(id: string): Promise<void>;
	/** 读一条运行记录（前台调用等结果前先看一眼：可能已经结束了） */
	get(id: string): SubagentRunView | null;
	/** 运行状态每次变化都推一遍（宿主直接投影进快照） */
	subscribe(listener: (run: SubagentRunView) => void): () => void;
	/** 宿主改了并发上限 / 关掉子代理：同步给引擎 */
	setConcurrency(limit: number): void;
	/**
	 * 子代理总开关：引擎按需**关掉委派能力本身**（codex：下一条会话就不给模型 spawn 工具），
	 * 而不是「留个调不通的按钮」。不实现 = 只靠并发上限（pi 的做法：模板停用即可）。
	 */
	setEnabled?(enabled: boolean): void;
	/** 切引擎 / 退出：停掉所有子代理，放掉它们的会话句柄 */
	dispose?(): void | Promise<void>;
};

export type EnginePort = {
	/** 引擎自己的版本号（界面上要显示 `pi v1.3.0` 这种）；拿不到返回 null */
	version?: () => string | null;
	/** 新建会话（ADR-0021 §2 起返回会话文件路径，供宿主列表用） */
	createSession(options: EngineSessionOptions): Promise<{
		sessionPath: string | null;
		engineSessionId?: string;
		/**
		 * 引擎**最终**给这条会话分配的 id。
		 *
		 * 为什多此一个字段：派生（fork）时 pi 的 `createBranchedSession()` 会自己生成一个 id，
		 * 我们传进去的 `sessionId` 它不采纳。宿主必须改用这个 id 当会话 id —— 否则内存里一个 id、
		 * 会话文件 header 里另一个 id，扫盘后侧栏就会出现两条指向同一个文件的会话。
		 * 不返回 = 引擎采纳了传入的 id（普通新建的现状）。
		 */
		sessionId?: string;
	}>;
	/**
	 * 把一条**临时会话**转正：把内存里的条目写成真正的会话文件（id 不变），
	 * 并重新打开会话（旧的内存句柄已失效）。返回新的会话文件路径。
	 *
	 * 不实现 = 这个引擎开不了临时会话，`capabilities.ephemeralChat` 应为 false。
	 */
	persistSession?(sessionId: string): Promise<{ sessionPath: string | null }>;
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
	/**
	 * 跑一次**一次性问答**（独立内存会话、无工具、不进当前会话历史）：
	 * 「让 AI 按会话内容起个名」用它。拿不到可用模型时返回 null（而非抛错）。
	 */
	suggestTitle?: (prompt: string) => Promise<string | null>;
	/** 删除会话（引擎原生删除）；没有这个能力时宿主退回到「把文件改名」 */
	deleteSession?: (handle: string) => Promise<void>;
	/** 读转录并映射成界面消息（text / tool 块）——侧栏与对话区都靠它 */
	readUiMessages(sessionId: string): Promise<UiMessage[]>;
	/** 危险操作前引擎会调用它；宿主负责弹给用户并等待决定（ADR-0006 审批三态） */
	setApprovalHandler(handler: ApprovalHandler): void;
	/**
	 * 「订阅服务」（OAuth 登录）：用 ChatGPT Plus/Pro、Claude Pro/Max 这类**订阅额度**
	 * 而不是 API key 计费。pi 的 ModelRuntime 已经实现了整套（login/logout/listCredentials），
	 * 引擎只负责把 SDK 的 prompt / notify 搬成这个形状；宿主负责搬给浏览器。
	 * **不实现的引擎 → 界面上不出现「订阅服务」这一块**（别假装支持）。
	 */
	providerAuth?: ProviderAuthPort;
	/**
	 * 子代理能力（多开 + 面板管理）。**不实现 → 界面上没有子代理模块**，
	 * 而不是「有个按钮、点了报错」。
	 */
	subagents?: SubagentEnginePort;
	/** 可用模型列表（ADR-0020 §P2）：`provider/modelId` + 给人看的标签 */
	listModels?(sessionId?: string): Promise<EngineModelInfo[]>;
	/**
	 * 引擎目录里的全部 provider（含**没配 key、现在用不了**的）。
	 * 宿主用它拼「官方内置服务商」列表：不实现 → 面板只列已在用的那些（现状）。
	 */
	listProviderCatalog?(): Promise<EngineProviderCatalogEntry[]>;
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
	/**
	 * 模型探针（界面上「模型 → 测速」那个按钮）：**真跑一个最小回合**，量首字节延迟与出字速度。
	 *
	 * 为什么要走引擎而不是像 pi 那样发一次 HTTP：codex / claude / opencode / dsh 的凭证在
	 * **它们自己的** auth 里（`~/.codex/auth.json`、`~/.claude/…`），工作台不持有 key，
	 * 也就没法拿 `chat/completions` 去 ping（见 providers/model-test.ts 的注释）。
	 * 引擎自己发一个 `ping` 回合，是唯一「不偷凭证、还能测出真实端到端速度」的做法。
	 *
	 * 代价：**会消耗真实额度**（几十 token / 个模型），所以界面必须二次确认。
	 * 不实现 → 界面上没有测速按钮（`capabilities.modelProbe` 保持 false）。
	 */
	probeModel?(modelId: string): Promise<ModelProbeResult>;
};

/**
 * 一次模型探针的结果。
 *
 * `ttftMs` = 从发出回合到**第一个字**（含思考流）的墙钟；`tps` = 出字速度（输出 token / 生成秒数）。
 * 两者都拿不到时给 `null`，界面就只显示总耗时 —— 不编数字。
 */
export type ModelProbeResult =
	| {
			ok: true;
			/** 首字节延迟（毫秒） */
			ttftMs: number | null;
			/** 整轮耗时（毫秒） */
			totalMs: number;
			/** 输出 token（引擎没给就是 0） */
			outputTokens: number;
			/**
			 * **生成速度**（token/秒）：只算「首字之后到收尾」这一段。
			 * 窗口太短（<500ms）或 token 太少时给 null —— 几十毫秒算出来的数是噪声，
			 * 更糟的是它会被 delta 攒包抬成假的几百 tok/s（实测踩过）。
			 */
			tps: number | null;
			/**
			 * **端到端均速**（token/秒，含首字延迟）：窗口短的时候用这个才不会骗人。
			 * 界面把它当兜底显示（`tps ?? averageTps`）。
			 */
			averageTps: number | null;
	  }
	| { ok: false; message: string };

// ---------------------------------------------------------------------------
// 订阅服务（OAuth）：port 只描述宿主需要的那几个动作，SDK 的细节留在 pi-sdk.ts
// ---------------------------------------------------------------------------

/** 一条可 OAuth 登录的 provider（界面上一张卡片） */
export type ProviderAuthEntry = {
	/** provider id（pi 的 `openai-codex` / `anthropic` / `github-copilot` …） */
	id: string;
	/** 给人看的名字（引擎的 OAuth 名称，宿主可以覆盖成更短的） */
	name: string;
	/** 引擎标注「这是订阅额度」而不是按 API key 计费 */
	subscription: boolean;
	/** 已经用 OAuth 凭据登录过（凭据在引擎自己的 auth.json 里） */
	connected: boolean;
	/** 同一个 provider 也能用 API key 登录（本面板不处理，只提示一句） */
	supportsApiKey: boolean;
	/** 现在能用的模型数（登录前后会变） */
	modelCount: number;
};

/** 登录过程中引擎要问用户的一句话 */
export type ProviderAuthPrompt = {
	type: "text" | "secret" | "manual_code" | "select";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
};

/** 登录过程中引擎汇报的事件 */
export type ProviderAuthEvent =
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string }
	| { type: "info"; message: string };

type ProviderAuthInteraction = {
	/** 引擎等用户回一个值（授权码 / 选登录方式）；`signal` 取消时应当 reject */
	prompt: (prompt: ProviderAuthPrompt) => Promise<string>;
	notify: (event: ProviderAuthEvent) => void;
	signal?: AbortSignal;
};

export type ProviderAuthPort = {
	list(): Promise<ProviderAuthEntry[]>;
	/** 登录成功即把凭据写进引擎自己的 auth.json，并重载模型表 */
	login(providerId: string, interaction: ProviderAuthInteraction): Promise<void>;
	logout(providerId: string): Promise<void>;
};
