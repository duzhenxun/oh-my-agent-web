/**
 * 真实引擎：用 pi SDK 实现「引擎端口」（ADR-0003）。
 *
 * ⚠️ 这是**唯一**允许 import `@earendil-works/*` 的地方（守卫 `check-engine-imports.mjs` 强制）。
 * 业务代码只见 `port.ts` 里的类型。
 *
 * 与 SDK 的对接方式（M3 侦察结论）：
 */
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { classifyScope } from "../approval/scope.js";
import { mapSessionEvent } from "./pi-events.js";
import { RETRY_MAX_ATTEMPTS, classifyProviderError, retryDelayMs, retryOmitTargets } from "./pi-retry.js";
import { createPiSubagents } from "./pi-subagents.js";
import { makeSubagentToolExtension } from "./pi-subagent-tool.js";
import { enabledSubagentSpecs, readSubagentSettings } from "../subagents/profile-store.js";
import { readSessionModel } from "./pi-session-model.js";
import { entriesToUiMessages } from "./pi-transcript.js";
import type {
	ApprovalHandler,
	EngineEvent,
	EngineMessage,
	EnginePort,
	EngineProviderCatalogEntry,
	EngineSessionOptions,
	ProviderAuthEntry,
	ProviderAuthEvent,
	ProviderAuthPrompt,
} from "./port.js";

type PiSdkEngineOptions = {
	/** 引擎 SDK 的全局配置目录（默认 ~/.pi/agent，模型与凭据都在那里） */
	agentDir?: string;
	/** 会话存储目录（默认 `~/.pi/agent/sessions/<编码后的 cwd>/`）。
	 * **测试必须显式传临时目录**：否则会写进用户的真实会话存储（踩过）。 */
	sessionDir?: string;
	/** 出问题时给宿主看的提示（不抛给用户，避免把一轮对话打死） */
	onNotice?: (text: string, level: "info" | "warn" | "error") => void;
	/**
	 * 结构化日志（引擎层没有 logger 实例，宿主把 createLogger 接进来）。
	 * 为什么必须有：provider 报错以前只变成界面上一条红条，**日志里一个字都没有** ——
	 * 用户报「有时会 engine.provider_error」时完全无从下手（进程日志里查不到原因）。
	 */
	log?: (level: "debug" | "info" | "warn" | "error", text: string, ctx?: Record<string, unknown>) => void;
	/**
	 * 额外的**技能目录**（`<dir>/<技能名>/SKILL.md`）。
	 *
	 * 为什么必须给：pi 的 `/skill:名字` 是在 `AgentSession.prompt()` 里展开的 —— 它按名字去
	 * `resourceLoader.getSkills()` 里找，**找不到就把原文原样交给模型**（不报错、不提示）。
	 * 而 pi 默认只扫 `<agentDir>/skills` 与 `<cwd>/.pi/skills`，本工作台的技能装在
	 * `~/.agents/skills` —— 于是 `/skill:xxx` 一直是「发出去了但没生效」：
	 * 界面上是一条正常的用户消息，模型收到的却是字面的 `/skill:xxx`。
	 */
	skillPaths?: string[];
	/**
	 * 「下一步建议」要几条（设置里「想想」的那个数，1~5）：**每条会话建的时候现读**。
	 * 不给就按默认 4~5 条教模型（见 suggestion-guidance.ts）。
	 */
	thinkCount?: () => number;
};

type SessionHandle = {
	// 用最小的结构类型描述我们真正用到的 SDK 面（避免把 SDK 类型漏到本文件之外）
	session: {
		prompt: (text: string) => Promise<void>;
		abort: () => Promise<void>;
		subscribe: (listener: (event: unknown) => void) => () => void;
		dispose: () => void;
		messages: unknown[];
		isStreaming: boolean;
		/** 底层 agent：自动重试用（`continue()` 从当前转录接着跑，不新增用户消息） */
		agent?: { continue: () => Promise<void> };
		/** 从会话文件重新投影出上下文（抹掉失败回复后要刷新 agent 状态） */
		refreshContext?: () => void;
		/** pi 原生的会话导出（`/export` 同一套序列化）：临时会话转正靠它落盘 */
		exportToJsonl: (outputPath: string) => string;
	};
	workspace: string;
	/** 取消**全部**监听器（关会话 / 切引擎时用） */
	unsubscribe: () => void;
	/**
	 * 当前挂着的订阅。**按次登记**：一轮在跑时「插队」会再 subscribe 一次，
	 * 以前两者共用一个 `unsubscribe` 字段，第二轮一结束就把第一轮的监听器弄丢（泄漏 + 事件重复）。
	 */
	subscriptions: Set<() => void>;
	/** 正在被 abort（用来把 agent_settled 翻译成「中断」而不是「完成」） */
	aborting: boolean;
	/** 会话转录的管理器（ADR-0021 §2：读条目 → 界面消息） */
	sessionManager: {
		getEntries: () => unknown[];
		getSessionFile: () => string | undefined;
		/** 追加一条 session_info（改会话显示名用，写进 pi 的会话文件） */
		appendSessionInfo?: (name: string) => string;
		/** 这条会话会不会落盘（临时会话是 false，见 `createSession.ephemeral`） */
		isPersisted: () => boolean;
		/** 会话头（id / timestamp / cwd / version）：转正与派生都要照抄它 */
		getHeader: () => AnyRecord | null;
		/** 从 `leafId` 往上走到根的整条路径（派生分支就是把它抄进新会话） */
		getBranch: (leafId?: string) => ForkEntry[];
		/** 把某条 entry 从**模型上下文**里去掉（重试时抹掉那条失败的回复；见 pi-retry.ts） */
		appendContextEdit?: (targetId: string, replacement: null) => string;
		getChildren: (parentId: string) => ForkEntry[];
		getEntry: (id: string) => ForkEntry | undefined;
	};
	/** 会话文件路径（新建后由 SDK 告知；打开时即入参） */
	sessionPath: string | null;
};

type AnyRecord = Record<string, unknown>;

/** 会话树上的一个 entry（派生 / 转正时只需要这几个字段） */
type ForkEntry = { type?: string; id: string; message?: unknown };

/**
 * 把界面上那条消息换算成**真正的分叉点**。
 *
 * 助手气泡是多条 entry 合并出来的（一次工具轮次 = 一条），它身上的 `UiMessage.id` 只是其中
 * 第一条；直接按它切会把这一轮的思考和工具块全丢掉。所以从这条消息往下走，走到
 * 「下一个用户消息之前」的最后一个 entry —— 那才是「这条回复真的说完了」的位置。
 */
function resolveForkLeaf(manager: SessionHandle["sessionManager"], messageId: string): string | null {
	if (!manager.getEntry(messageId)) return null;
	let leaf = messageId;
	// 沿树往下（只认最后一个孩子）；碰到下一条用户消息就停：那是下一轮了
	for (let guard = 0; guard < 10_000; guard += 1) {
		const next = manager.getChildren(leaf).at(-1);
		if (!next) break;
		if (next.type === "message" && asRecord(next.message).role === "user") break;
		leaf = next.id;
	}
	return leaf;
}

function asRecord(value: unknown): AnyRecord {
	return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

/**
 * pi 的「已经在跑了」那句拒绝（`Agent is already processing. Specify streamingBehavior…`）。
 * 宿主拿它判断「这条其实该插队」—— 见 sendMessage 里的兜底。
 */
function isAlreadyProcessing(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Agent is already processing");
}

/**
 * 插队那条要等「这一轮真的 settle」才算收尾；这个上限只是兜底，
 * 免得 pi 万一不吐 agent_settled（abort 失败之类）时回合永远不收尾（宿主看门狗本来也会 interrupt）。
 */
const STEER_SETTLE_FALLBACK_MS = 20 * 60 * 1000;

/**
 * 普通（非插队）回合的「等 settle」宽限。
 *
 * `prompt()` 返回时收尾事件（agent_settled / 最后的 message_end）可能还在路上：
 * 本来只给 50ms，一步慢机器上就会错过 —— 后果不是报错而是**静默错报**：
 * `interrupted` 只在 agent_settled 里置位，错过它的话「用户点停的回合」会被报成 `turn_end: done`，
 * 而且 finally 里的 unsubscribe 会把尾帧（含 usage）一起丢掉（token/费用少记）。
 * 800ms 是个只影响「settle 干脆不来」那种病态情况的兵底，正常回合 settles 一到就返回。
 */
const SETTLE_GRACE_MS = 800;

/** 退避用的小工具（不引入依赖；`.unref()` 免得挂着一个没人等的定时器） */
function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}

/** 引擎层的日志出口：没接日志时啥也不干（测试里就这么跑） */
type EngineLog = (level: "debug" | "info" | "warn" | "error", text: string, ctx?: Record<string, unknown>) => void;

/**
 * 重试前把这一轮失败的回复从**模型上下文**里抹掉（`context_edit` = null）。
 *
 * 为什么必须做：pi 的 `agent.continue()` 要求转录末尾是用户消息 / 工具结果 ——
 * 而失败之后末尾躺着一条空的（或半截的）助手消息，直接续跑会被它顶回来
 * （`Cannot continue from message role: assistant`）。pi 自己的自动重试走的也是
 * 「先抹掉、再 continue」这一套（见 SDK 的 `_omitRecoveryAttempt`）。
 *
 * 用户那条提问**不动**：重试是从它接着跑，不重复发一遍。
 */
function omitFailedAttempt(handle: SessionHandle, log: EngineLog, sessionId: string): boolean {
	const manager = handle.sessionManager;
	const edit = manager.appendContextEdit;
	const refresh = handle.session.refreshContext;
	if (!edit || !refresh) return false;

	let targets: string[];
	try {
		targets = retryOmitTargets(manager.getBranch());
	} catch (error) {
		log("warn", "读会话树失败，放弃自动重试", { sessionId, message: errorMessageOf(error) });
		return false;
	}
	if (targets.length === 0) return false;

	try {
		for (const id of targets) edit.call(manager, id, null);
		refresh.call(handle.session);
		return true;
	} catch (error) {
		log("warn", "抹掉失败回复失败，放弃自动重试", { sessionId, message: errorMessageOf(error) });
		return false;
	}
}

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 订阅服务里用到的 ModelRuntime 面（和 model-registry-reload.ts 一样：只描述真正用到的部分，
 * 不让 SDK 类型漏到 port 之外）。
 */
type AuthRuntime = {
	getProviders: () => readonly {
		id: string;
		name: string;
		auth: { apiKey?: unknown; oauth?: { name?: string; isSubscription?: boolean } };
	}[];
	getModels: (providerId?: string) => readonly unknown[];
	listCredentials: () => Promise<readonly { providerId: string; type: string }[]>;
	login: (providerId: string, type: "oauth", interaction: unknown) => Promise<unknown>;
	logout: (providerId: string) => Promise<void>;
};

/**
 * provider 的显示名：只覆盖 SDK 名字太长/不直观的两个，
 * 其余直接用引擎给的 OAuth 名称（`Anthropic (Claude Pro/Max)`、`xAI (Grok/X subscription)` 等）。
 */
const OAUTH_LABELS: Record<string, string> = {
	"openai-codex": "ChatGPT Plus/Pro",
	"github-copilot": "GitHub Copilot",
};

/**
 * 「只填 key 还不够」的 provider：还得有端点 / 云凭证。
 * 写死名单而不是去猜 provider 定义：这些的 baseUrl 要么挂在模型上、要么要 account id，
 * 而 pi 的 provider 对象没有「需不需要额外配置」这个字段。
 */
const NEEDS_EXTRA_CONFIG = new Set([
	"amazon-bedrock",
	"google-vertex",
	"azure",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
]);

/** SDK 的 AuthPrompt → 端口的 ProviderAuthPrompt */
function toAuthPrompt(prompt: unknown): ProviderAuthPrompt {
	const record = asRecord(prompt);
	const type = record.type;
	const options = Array.isArray(record.options)
		? record.options.map((option) => {
				const item = asRecord(option);
				return {
					id: String(item.id ?? ""),
					label: String(item.label ?? item.id ?? ""),
					...(typeof item.description === "string" ? { description: item.description } : {}),
				};
			})
		: undefined;
	return {
		type: type === "select" || type === "secret" || type === "manual_code" || type === "text" ? type : "text",
		message: String(record.message ?? ""),
		...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
		...(options ? { options } : {}),
	};
}

/** SDK 的 AuthEvent → 端口的 ProviderAuthEvent（未知事件当 info，不静默丢） */
function toAuthEvent(event: unknown): ProviderAuthEvent {
	const record = asRecord(event);
	if (record.type === "auth_url" && typeof record.url === "string") {
		return {
			type: "auth_url",
			url: record.url,
			...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}),
		};
	}
	if (record.type === "device_code" && typeof record.userCode === "string") {
		return {
			type: "device_code",
			userCode: record.userCode,
			verificationUri: String(record.verificationUri ?? ""),
			...(typeof record.intervalSeconds === "number" ? { intervalSeconds: record.intervalSeconds } : {}),
			...(typeof record.expiresInSeconds === "number" ? { expiresInSeconds: record.expiresInSeconds } : {}),
		};
	}
	if (record.type === "progress") return { type: "progress", message: String(record.message ?? "") };
	return { type: "info", message: String(record.message ?? "") };
}

/** 教模型怎么写「下一步建议」（ADR-0022）：刻意写得短（每次请求都付 token） */
import { reloadModelRegistry } from "./model-registry-reload.js";
import { NARRATE_GUIDANCE } from "./narrate-guidance.js";
import { SUGGESTION_GUIDANCE, suggestionGuidance } from "./suggestion-guidance.js";
import { SUBAGENT_GUIDANCE } from "./subagent-guidance.js";

export { NARRATE_GUIDANCE, SUGGESTION_GUIDANCE, SUBAGENT_GUIDANCE };

import { createPiThinking } from "./pi-thinking.js";
import { piSdkVersion } from "./pi-version.js";
import { renameSessionIn } from "./pi-rename.js";

export function createPiSdkEngine(options: PiSdkEngineOptions = {}): EnginePort {
	/**
	 * pi 的 `theme` 是个全局 Proxy：没调过 `initTheme()` 就抛
	 * `Theme not initialized. Call initTheme() first.`（import 本身**不会**初始化它）。
	 *
	 * TUI 启动时自己会初始化，而这个无界面的工作台不会 —— 但扩展里那些「给终端画东西」的代码
	 * （`getMarkdownTheme().heading()`、`new Text(..., theme.fg(...))`）照样会被调用，尤其是
	 * 塞在 `setTimeout` 里的渲染：那个异常没人接，**直接把这个服务进程带走**（同事机器上真踩过：
	 * 扩展 `token-speed.ts` 的定时渲染崩了整个 agent-web）。
	 *
	 * 所以宿主这边先初始化一次，让这类渲染退化成「画了个没人看的东西」，而不是崩服务。
	 * 顺带也是所有 `@earendil-works/*` 导入的唯一出口（本文件）。
	 */
	initTheme();

	const sessions = new Map<string, SessionHandle>();
	const thinking = createPiThinking(sessions as unknown as Map<string, { session: unknown }>);
	let approvalHandler: ApprovalHandler | null = null;

	const notice = (text: string, level: "info" | "warn" | "error" = "warn") => options.onNotice?.(text, level);

	/** 日志出口：没接线时是空函数（单测里就这么跑） */
	const log: EngineLog = (level, text, ctx) => options.log?.(level, text, ctx);

	// 子代理运行时（ADR：多开 + 面板管理）：会话文件放在父会话旁边，工具白名单来自模板
	const resolvedAgentDir = options.agentDir ?? getAgentDir();
	const subagentSettings = readSubagentSettings(resolvedAgentDir);
	const subagents = createPiSubagents({
		agentDir: resolvedAgentDir,
		sessionDir: options.sessionDir,
		concurrency: subagentSettings.concurrency,
		onNotice: (text, level) => notice(text, level ?? "warn"),
		// 子代理沿用父会话的模型运行时 / 当前模型（不然扩展提供的 provider 在子会话里不存在）
		getParentSession: (conversationId) => sessions.get(conversationId)?.session ?? null,
	});

	/**
	 * 审批用的 inline 扩展：拦在工具真正执行之前（SDK 的公开拦截点）。
	 *
	 * 这个扩展是**按会话**建的（见 startSession），所以能把会话 id 一起带上 ——
	 * 回合收尾时宿主据此只收掉本会话悬着的审批，不会误伤并行跑着的其它会话。
	 */
	function makeApprovalExtension(workspace: string, conversationId: string) {
		return {
			name: "agent-web-approval",
			hidden: true,
			factory: (pi: ExtensionAPI) => {
				pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
					const record = asRecord(event);
					const scope = classifyScope({
						toolName: String(record.toolName ?? ""),
						args: record.input,
						workspace,
					});
					if (!scope.dangerous) return undefined; // 只读工具不问

					const decision = approvalHandler
						? await approvalHandler({
								conversationId,
								toolName: scope.toolName,
								argsSummary: scope.argsSummary,
								scopeKey: scope.scopeKey,
								scopeHint: scope.scopeHint,
								riskNote: scope.riskNote,
							})
						: "deny";
					if (decision === "deny") {
						return { block: true, reason: "用户拒绝了这次操作（不要在未获批准时重试同一操作）" };
					}
					return undefined;
				});
			},
		};
	}

	/**
	 * 算一个新会话文件的路径 + 建好目录（**不写文件**）。
	 *
	 * 借用一次 `SessionManager.create` 来算：文件名格式（`<ISO 时间>_<id>.jsonl`）与 pi 自己写的
	 * 完全一致。自己拼文件名的话，一旦 pi 改了格式，侧栏扫描器就找不到这些会话。
	 */
	function sessionFileFor(workspace: string, id: string): string {
		const file = SessionManager.create(workspace, options.sessionDir, { id }).getSessionFile();
		if (!file) throw new Error("无法确定会话文件路径（会话目录不可写）");
		return file;
	}

	/** 这个工作区的会话目录（布局跟 pi 自己的完全一致） */
	function sessionDirFor(workspace: string): string {
		return dirname(sessionFileFor(workspace, "probe"));
	}

	/** 建 resourceLoader 并拉起一个 AgentSession（createSession 与 openSession 共用） */
	async function startSession(
		sessionId: string,
		workspace: string,
		sessionManager: ReturnType<typeof SessionManager.inMemory>,
		sessionPath: string | null = null,
	): Promise<SessionHandle> {
		const agentDir = options.agentDir ?? getAgentDir();
		// 子会话要按父会话归档：会话文件名在 createAgentSession 之后才确定，所以用一个懒引用
		const parentSessionPath = () => sessionManager.getSessionFile() ?? sessionPath;
		const extensionFactories: InlineExtension[] = [makeApprovalExtension(workspace, sessionId)];
		// 子代理开着、且有可用模板时，才把「什么时候派活」这段拼进系统提示
		const subagentReady =
			sessionId !== PREWARM_ID && readSubagentSettings(agentDir).enabled && enabledSubagentSpecs(agentDir).length > 0;
		// 预热会话不暴露 Agent 工具：它不下发提示词，给它一个委派入口只会误伤
		if (sessionId !== PREWARM_ID) {
			extensionFactories.push(
				makeSubagentToolExtension({
					port: subagents,
					agentDir,
					conversationId: sessionId,
					workspace,
					parentSessionPath,
				}),
			);
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			// 本工作台的技能目录（默认 `~/.agents/skills`）：pi 自己不扫那里，
			// 不显式加上的话 `/skill:xxx` 不会被展开成技能正文（见 PiSdkEngineOptions.skillPaths）
			...(options.skillPaths && options.skillPaths.length > 0 ? { additionalSkillPaths: options.skillPaths } : {}),
			extensionFactories,
			// 教模型「下一步建议」的写法（ADR-0022）：纯文本标记，不需要调用任何工具
			// 「动手前先说话」：过程默认折叠，不写正文用户就不知道它在干什么
			appendSystemPrompt: [
				suggestionGuidance(options.thinkCount?.() ?? null),
				NARRATE_GUIDANCE,
				...(subagentReady ? [SUBAGENT_GUIDANCE] : []),
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			resourceLoader,
			// ADR-0021 §2：转录的事实源就是 SDK 自己的会话文件（新建或打开的那个）
			sessionManager,
		});

		const subscriptions = new Set<() => void>();
		const handle: SessionHandle = {
			session: session as unknown as SessionHandle["session"],
			workspace,
			unsubscribe: () => {
				for (const off of subscriptions) off();
				subscriptions.clear();
			},
			subscriptions,
			aborting: false,
			sessionManager: sessionManager as unknown as SessionHandle["sessionManager"],
			sessionPath: sessionPath ?? sessionManager.getSessionFile() ?? null,
		};
		sessions.set(sessionId, handle);
		return handle;
	}

	const PREWARM_ID = "__prewarm__";

	async function warmUp() {
		if (sessions.has(PREWARM_ID)) return;
		try {
			await startSession(PREWARM_ID, process.cwd(), SessionManager.inMemory());
		} catch (error) {
			options.onNotice?.(`模型表预热失败：${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	}

	/**
	 * 订阅服务要一个 ModelRuntime：优先用预热会话的那个（内存会话，不落盘），
	 * 没有就建一个 —— 不带任何会话也让用户先登录。
	 */
	async function authRuntime(): Promise<AuthRuntime | null> {
		const runtimeOf = (handle: SessionHandle | undefined): AuthRuntime | null => {
			if (!handle) return null;
			return (handle.session as unknown as { modelRuntime?: AuthRuntime }).modelRuntime ?? null;
		};

		const existing = runtimeOf(sessions.get(PREWARM_ID) ?? [...sessions.values()].at(-1));
		if (existing) return existing;
		await warmUp();
		return runtimeOf(sessions.get(PREWARM_ID));
	}

	/** 接口给界面的一行：能 OAuth 登录的 provider + 当前连上了没 */
	async function listProviderAuth(): Promise<ProviderAuthEntry[]> {
		const runtime = await authRuntime();
		if (!runtime) return [];
		const credentials = new Map<string, string>();
		try {
			for (const credential of await runtime.listCredentials()) {
				credentials.set(credential.providerId, credential.type);
			}
		} catch {
			// auth.json 坏了不该让整个列表空掉：退回「都算未连接」
		}
		return runtime
			.getProviders()
			.filter((provider) => Boolean(provider.auth.oauth))
			.map((provider) => ({
				id: provider.id,
				name: OAUTH_LABELS[provider.id] ?? provider.auth.oauth?.name ?? provider.name,
				subscription: provider.auth.oauth?.isSubscription === true,
				connected: credentials.get(provider.id) === "oauth",
				supportsApiKey: Boolean(provider.auth.apiKey),
				modelCount: runtime.getModels(provider.id).length,
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	/**
	 * 引擎目录里的全部 provider（ADR-0004 快照 / 「官方内置服务商」分组）。
	 *
	 * 与 `listModels()` 的区别：那个只回**已鉴权**的，这里连「没配 key 的」也列 ——
	 * 界面才有一个地方让用户粘 key。两个标记决定能不能归到「填 key 就能用」：
	 *   - `oauthOnly`：pi 只给了订阅登录（openai-codex），填 key 没用；
	 *   - `needsExtraConfig`：除了 key 还要端点 / 云凭证（bedrock、vertex、azure、cloudflare）。
	 * 名单按 id 写死：pi 的 provider 定义没有「需不需要额外配置」这个字段，而靠猜更不可靠。
	 */
	async function listProviderCatalog(): Promise<EngineProviderCatalogEntry[]> {
		const runtime = await authRuntime();
		if (!runtime) return [];
		return runtime
			.getProviders()
			.map((provider) => {
				const apiKey = Boolean(provider.auth.apiKey);
				const oauth = Boolean(provider.auth.oauth);
				const models = runtime.getModels(provider.id) as Array<{ id: string; baseUrl?: string; api?: string }>;
				// SDK 的 Provider 类型里没写 baseUrl（运行时是有的，pi-ai 的 createProvider 会给）：
				// 这里只读一个可选的显示信息，不值得为它去引 pi-ai 的内部类型。
				const declaredBaseUrl = (provider as unknown as { baseUrl?: string }).baseUrl;
				/**
				 * 端点 / 协议可能**挂在模型上**而不是 provider 上（opencode / opencode-go 就是这种，
				 * 而且同一家还混着 anthropic / openai / gemini 三种协议）。
				 * 运行时拿到的模型对象不一定带这些字段，所以再拿 pi 的静态目录按 id 补一份。
				 */
				const builtin = getBuiltinModels(provider.id as Parameters<typeof getBuiltinModels>[0]);
				const specById = new Map<string, { api?: string; baseUrl?: string }>();
				for (const model of builtin) {
					specById.set(model.id, {
						...(typeof model.api === "string" && model.api !== "" ? { api: model.api } : {}),
						...(typeof model.baseUrl === "string" && model.baseUrl !== "" ? { baseUrl: model.baseUrl } : {}),
					});
				}
				const modelSpecs = models.map((model) => ({
					id: model.id,
					...((model.api ?? specById.get(model.id)?.api) ? { api: model.api ?? specById.get(model.id)?.api } : {}),
					...((model.baseUrl ?? specById.get(model.id)?.baseUrl)
						? { baseUrl: model.baseUrl ?? specById.get(model.id)?.baseUrl }
						: {}),
				}));
				const baseUrl =
					declaredBaseUrl ??
					modelSpecs.find((model) => model.baseUrl !== undefined)?.baseUrl ??
					models.find((model) => typeof model.baseUrl === "string" && model.baseUrl !== "")?.baseUrl;
				const api =
					modelSpecs.find((model) => model.api !== undefined)?.api ??
					models.find((model) => typeof model.api === "string" && model.api !== "")?.api;
				return {
					provider: provider.id,
					name: provider.name,
					...(baseUrl ? { baseUrl } : {}),
					...(api ? { api } : {}),
					...(modelSpecs.length > 0 ? { models: modelSpecs } : {}),
					modelCount: models.length,
					...(apiKey ? {} : oauth ? { oauthOnly: true } : { needsExtraConfig: true }),
					...(NEEDS_EXTRA_CONFIG.has(provider.id) ? { needsExtraConfig: true } : {}),
				};
			})
			.sort((left, right) => left.provider.localeCompare(right.provider));
	}

	return {
		/** 预热：pi 的 modelRuntime 挂在会话上，没会话就列不出模型（内存会话，不落盘） */
		async prewarm() {
			if (sessions.has(PREWARM_ID)) return;
			try {
				await startSession(PREWARM_ID, process.cwd(), SessionManager.inMemory());
			} catch (error) {
				options.onNotice?.(`模型表预热失败：${error instanceof Error ? error.message : String(error)}`, "warn");
			}
		},

		version: piSdkVersion,
		reloadModels: () => reloadModelRegistry(sessions, PREWARM_ID, warmUp, options.agentDir ?? getAgentDir()),
		/** 子代理：起子会话 / 停掉它 / 状态订阅（宿主投影进快照） */
		subagents,

		providerAuth: {
			list: () => listProviderAuth(),

			async login(providerId, interaction) {
				const runtime = await authRuntime();
				if (!runtime) throw new Error("引擎还没拿到模型运行时（先开一次会话，或稍后重试）");
				if (!runtime.getProviders().find((provider) => provider.id === providerId)?.auth.oauth) {
					throw new Error(`${providerId} 不支持订阅登录`);
				}
				await runtime.login(providerId, "oauth", {
					prompt: (prompt: unknown) => interaction.prompt(toAuthPrompt(prompt)),
					notify: (event: unknown) => interaction.notify(toAuthEvent(event)),
					...(interaction.signal ? { signal: interaction.signal } : {}),
				});
				// 凭据已写进引擎的 auth.json：重载模型表，不然新 provider 的模型要等下次重启才出现
				await reloadModelRegistry(sessions, PREWARM_ID, warmUp, options.agentDir ?? getAgentDir());
			},

			async logout(providerId) {
				const runtime = await authRuntime();
				if (!runtime) throw new Error("引擎还没拿到模型运行时");
				await runtime.logout(providerId);
				await reloadModelRegistry(sessions, PREWARM_ID, warmUp, options.agentDir ?? getAgentDir());
			},
		},

		async createSession(sessionOptions: EngineSessionOptions) {
			const { sessionId, workspace, ephemeral, fork } = sessionOptions;

			// ── 派生（分支）：与 pi 自己 `/fork` 的做法一致（见 SDK 的 agent-session-runtime）──
			// 关键是**另开一个 manager 读同一个文件**：`createBranchedSession` 会把它自己指向新文件，
			// 而源会话那个 manager 完全不受影响 —— 所以原对话一个字不动。
			if (fork) {
				const source = sessions.get(fork.sourceSessionId);
				// pi 原生的拒绝理由就是这句：没落盘的会话不能 fork（`/clone` 前先说话）
				if (!source?.sessionPath) throw new Error("这条会话还没存过盘（临时对话），不能从它派生分支");
				const leafId = resolveForkLeaf(source.sessionManager, fork.leafId);
				if (!leafId) throw new Error("找不到要分叉的那条消息（它可能不在当前分支上）");

				// 新会话的目录跟新工作区走（布局与 pi 自己的完全一致）
				const sessionManager = SessionManager.open(source.sessionPath, sessionDirFor(workspace), workspace);
				const forkedPath = sessionManager.createBranchedSession(leafId);
				if (!forkedPath) throw new Error("派生会话文件创建失败");
				// `createBranchedSession` 会给派生会话**另生一个 id** 并写进新文件头（pi 自己的 `/fork` 也这样）：
				// 句柄必须按**它**登记，不能按传进来的 `sessionId` —— 宿主要拿它当会话 id（见
				// `conversation-create.ts` 的 `engineAssignedId ?? planned`），这里不跟上，之后发消息就是
				// `engine.no_session`（引擎的表里只有那个没被采用的 id）。
				const forkedId = sessionManager.getSessionId();
				await startSession(forkedId, workspace, sessionManager, forkedPath);
				return { sessionPath: forkedPath, sessionId: forkedId };
			}

			// ── 临时会话 = pi 的 `--no-session`：纯内存，不建文件、不进历史 ──
			if (ephemeral) {
				const sessionManager = SessionManager.inMemory(workspace, { id: sessionId });
				await startSession(sessionId, workspace, sessionManager);
				return { sessionPath: null };
			}

			// ADR-0021 §2：新建会话就落在 **pi 的会话存储**里（不再用 inMemory + 自建 jsonl），
			// 用我们的 sessionId 当 SDK 的会话 id → 两边 id 空间完全一致。
			const sessionManager = SessionManager.create(workspace, options.sessionDir, {
				id: sessionOptions.sessionId,
			});
			const handle = await startSession(sessionOptions.sessionId, sessionOptions.workspace, sessionManager);
			return { sessionPath: handle.sessionPath };
		},

		/**
		 * 临时会话转正：用 pi 原生导出让文件落盘（id 不变），再关掉重开。
		 *
		 * 序列化走 `session.exportToJsonl()`—— pi 自己的 `/export` 用的就是它，我们一个字不自己拼。
		 * 为什么必须「重开」：内存句柄对那个文件一无所知，不换掉它的话，之后说的话还是不会落盘
		 * （看着已经存了，其实一个字没进文件）。重开后上下文不变：历史就在文件里。
		 */
		async persistSession(sessionId: string) {
			const handle = sessions.get(sessionId);
			if (!handle) return { sessionPath: null };
			const manager = handle.sessionManager;
			// 已经是落盘的会话：直接回它的文件（幂等：重复点「保存为正式对话」不会写出两份）
			if (manager.isPersisted()) return { sessionPath: manager.getSessionFile() ?? null };

			const entries = manager.getEntries();
			// 一个字都还没说：不值得落盘（空会话进历史只会变成一个没法看的空行）
			if (!entries.some((entry) => asRecord(entry).type === "message")) return { sessionPath: null };

			const workspace = handle.workspace;
			const sessionPath = sessionFileFor(workspace, sessionId);
			// 原生导出：header + 当前分支的全部条目（id 就是这条会话原来的 id）
			handle.session.exportToJsonl(sessionPath);

			handle.unsubscribe();
			try {
				handle.session.dispose();
			} catch {
				// 已经关掉了
			}
			sessions.delete(sessionId);
			const reopened = SessionManager.open(sessionPath, options.sessionDir, workspace);
			await startSession(sessionId, workspace, reopened, sessionPath);
			return { sessionPath };
		},

		async openSession(openOptions) {
			const sessionPath = openOptions.sessionPath ?? openOptions.engineSessionId;
			if (!sessionPath) throw new Error("pi 打开会话需要 sessionPath（文件路径）");
			const sessionManager = SessionManager.open(sessionPath, options.sessionDir); // header 里的 cwd + 同一个文件续写
			const workspace = sessionManager.getCwd() || process.cwd();
			await startSession(openOptions.sessionId, workspace, sessionManager, sessionPath);
		},

		renameSession: (sessionPath, name) => renameSessionIn(sessions, sessionPath, name, options.sessionDir),

		/**
		 * 「按会话内容起个名」：一次**独立**的一次性问答。
		 *
		 * 为什么自己开一个会话而不是往当前会话里塞一句提示词：起名不该出现在用户的
		 * 对话里（不能污染历史、不能算一轮、不能被用户看到）。所以用 `inMemory()` 的
		 * SessionManager（不落盘、不进 session 列表）+ `noTools`（不调工具）。
		 *
		 * 模型跟**当前全局选择**走：拿预热会话的 `model` / `modelRuntime` 直接用，
		 * 不重新解析凭据 —— 因此「没有可用模型」时返回 null，交给上层提示文案。
		 */
		async suggestTitle(prompt) {
			const handle = sessions.get(PREWARM_ID) ?? [...sessions.values()].at(-1);
			const source = handle?.session as unknown as { modelRuntime?: unknown; model?: unknown } | undefined;
			if (!source?.modelRuntime || !source.model) {
				// 没有预热会话（从未发过消息 / 刚启动）→ 现场预热一次再说
				await warmUp();
			}
			const warm = sessions.get(PREWARM_ID) ?? handle;
			const from = warm?.session as unknown as { modelRuntime?: unknown; model?: unknown } | undefined;
			if (!from?.modelRuntime || !from.model) return null;

			const disposable = await createAgentSession({
				cwd: process.cwd(),
				sessionManager: SessionManager.inMemory(),
				noTools: "all",
				/**
				 * 故意用一只「空资源」的 loader：起名不需要技能 / 扩展 / 上下文文件 / 主题，
				 * 全关掉只剩一句系统提示词 —— 否则点一下图标就要白扫一遍 skill 与 AGENTS.md，
				 * 既慢又白烧 token。
				 */
				resourceLoader: new DefaultResourceLoader({
					cwd: process.cwd(),
					agentDir: options.agentDir ?? getAgentDir(),
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: "你是一个给会话起标题的助手。只输出标题本身，不要解释。",
				}),
				modelRuntime: from.modelRuntime as never,
				model: from.model as never,
			});
			try {
				await disposable.session.prompt(prompt);
				return disposable.session.getLastAssistantText() ?? null;
			} finally {
				// 一次性会话：问完就丢（dispose 会 abort 掉还在跑的东西）
				disposable.session.dispose();
			}
		},
		async readUiMessages(sessionId) {
			const handle = sessions.get(sessionId);
			if (!handle) return [];
			// 这一轮还在跑：中间那条工具的结果只是还没落盘，别提前判成失败（切回来看会话时会发生）
			const live = handle.session.isStreaming === true || handle.subscriptions.size > 0;
			return entriesToUiMessages(handle.sessionManager.getEntries(), { live });
		},

		async sendMessage(
			sessionId: string,
			text: string,
			onEvent: (event: EngineEvent) => void,
			messageOptions?: {
				images?: Array<{ data: string; mimeType: string }>;
				streamingBehavior?: "steer" | "followUp";
			},
		) {
			const found = sessions.get(sessionId);
			if (!found) {
				onEvent({ type: "error", code: "engine.no_session", message: `引擎里没有这个会话：${sessionId}` });
				onEvent({ type: "turn_end", reason: "error" });
				return;
			}
			// 换个别名：下面 `runAttempt` 是**函数声明**（会被提升），TS 不会把上面的收窄带进去
			const handle = found;

			handle.aborting = false;

			/**
			 * 一轮的收尾结果（自动重试用）。
			 * provider 报错**先攒着不发**：中间那些马上会被重试掉的失败不该在界面上留一条红条，
			 * 最终由下面决定往外发哪一条。
			 */
			type AttemptOutcome = {
				failed: { code: string; message: string } | null;
				errors: Array<{ code: string; message: string }>;
				interrupted: boolean;
				/** 这一轮有没有往界面上吐过东西（正文 / 思考 / 工具卡） */
				producedOutput: boolean;
				/** 这条消息是被「插进正在跑的那一轮」的 */
				steered: boolean;
			};

			// 图片走 SDK 的 images 参数（视觉注入）；没有图片时不传，避免空数组影响提示词缓存
			const images = messageOptions?.images?.map((image) => ({
				type: "image" as const,
				data: image.data,
				mimeType: image.mimeType,
			}));
			// streamingBehavior 交给 pi 自己排队：steer = 打断当前轮插入，followUp = 等这轮结束
			const promptOptions: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" } = {};
			if (images && images.length > 0) promptOptions.images = images;
			if (messageOptions?.streamingBehavior) promptOptions.streamingBehavior = messageOptions.streamingBehavior;

			/** 跑一轮（第一次 = 发用户消息；重试 = 从转录续跑）并等它收尾 */
			async function runAttempt(index: number): Promise<AttemptOutcome> {
				let interrupted = false;
				let producedOutput = false;
				let steered = false;
				let failed: AttemptOutcome["failed"] = null;
				const errors: AttemptOutcome["errors"] = [];
				let markSettled: (() => void) | null = null;
				const settled = new Promise<void>((resolve) => {
					markSettled = resolve;
				});

				// 订阅**按次**持有：steer 会并发再进一次 sendMessage，两轮各自摘自己的监听器
				const off = handle.session.subscribe((event: unknown) => {
					const mapped = mapSessionEvent(event);
					if (mapped) {
						// provider 报错也要算「这一轮失败」：不能最后还发 turn_end: done。
						// 先攒着不发 —— 这类错误很可能下一步就被重试掉了。
						if (mapped.type === "error") {
							errors.push({ code: mapped.code, message: mapped.message });
							// 每一次 provider 报错都进日志（以前只有界面上一条红条，日志里查不到任何东西）
							log("warn", "provider 报错", {
								sessionId,
								attempt: index,
								code: mapped.code,
								message: mapped.message,
							});
							return;
						}
						if (
							mapped.type === "text_delta" ||
							mapped.type === "thinking_delta" ||
							mapped.type === "tool_start" ||
							mapped.type === "tool_end"
						) {
							producedOutput = true;
						}
						onEvent(mapped);
						return;
					}
					const record = asRecord(event);
					// pi 自己的重试（overloaded / 5xx / socket hang up 那几类）：记一笔就够，
					// 界面上不打扰 —— 用户看到的仍然是一轮正常的回答。
					if (record.type === "auto_retry_start") {
						log("info", "pi 自动重试", { sessionId, attempt: record.attempt, reason: record.errorMessage });
						return;
					}
					if (record.type === "agent_settled") {
						interrupted = record.aborted === true || handle.aborting;
						markSettled?.();
					}
				});
				handle.subscriptions.add(off);

				try {
					if (index === 0) {
						const session = handle.session as unknown as {
							prompt: (text: string, options: typeof promptOptions) => Promise<void>;
						};
						try {
							await session.prompt(text, promptOptions);
						} catch (error) {
							/**
							 * pi 说「已经在跑了」= 宿主的忙碌判断和 pi 的 `isStreaming` 错开了一步（排队排空恰好撞上
							 * 上一轮还没真正 settle、看门狗强制收尾、插队与 settle 抢跑……）。
							 * 这**不是**「回合失败」而是「该插队」：补一次 steer 交给 pi 排队（与 turn-queue 的
							 * flushSteer 同一语义），别把用户那条消息变成界面上的一条红条、然后人也没了。
							 * 已经就是 steer 还报这句 = 真异常，照旧报错。
							 */
							if (promptOptions.streamingBehavior === "steer" || !isAlreadyProcessing(error)) throw error;
							await session.prompt(text, { ...promptOptions, streamingBehavior: "steer" });
							steered = true;
						}
					} else {
						// 重试：从当前转录接着跑（那条失败的回复已经被 omitFailedAttempt 抹掉了，
						// 所以这里**不会**再发一遍用户消息）
						const agent = handle.session.agent;
						if (!agent?.continue) throw new Error("这个 pi 版本不支持从转录续跑，无法自动重试");
						await agent.continue();
					}
					// 等 settle：prompt() 返回后仍可能有收尾事件（插队那条更要等整轮真结束，否则会提前收尾）
					if (steered)
						await Promise.race([
							settled,
							new Promise<void>((done) => setTimeout(done, STEER_SETTLE_FALLBACK_MS).unref?.()),
						]);
					else await Promise.race([settled, sleep(SETTLE_GRACE_MS)]);
				} catch (error) {
					failed = { code: "engine.prompt_failed", message: errorMessageOf(error) };
				} finally {
					off();
					handle.subscriptions.delete(off);
				}

				return { failed, errors, interrupted, producedOutput, steered };
			}

			let attempt = 0;
			let outcome = await runAttempt(0);
			/**
			 * 自动重试（见 pi-retry.ts）：pi 只重试它认得出来的瞬时错误，
			 * 「This operation was aborted」这种传输层 abort 它一律当终态 —— 实际观感就是
			 * 「模型刚连上就被掐断，界面一条红条，这一轮没了，而用户什么都没干」。
			 *
			 * 三条边界：
			 *   1. 用户点停 / 看门狗中断（`aborting` / `interrupted`）—— 绝不重试；
			 *   2. 这一轮已经往界面上吐过东西（正文 / 思考 / 工具卡）—— 不重试：
			 *      重来的答案会和上一段粘在同一个气泡里，比报错更让人困惑；
			 *   3. 插队（steer）那条不重试：它属于正在跑的那一轮，重跑会把上下文搅乱。
			 */
			const retryBudget = messageOptions?.streamingBehavior ? 0 : RETRY_MAX_ATTEMPTS;
			/**
			 * 重试进度走事件（`retry`）而不是 `onNotice`：
			 *   · `retry` → 显示在「正在等待模型…」那一行（退避期间屏幕是静的，必须有一行字说明还在跑）；
			 *   · `notice`（同 key 原地替换）→ 恢复后一句「已自动恢复」，不堆行。
			 * 引擎的 `sessionId` 就是会话 id（宿主 `engine.sendMessage(conv, …)`）。
			 */
			const retryNoticeKey = `engine-retry:${sessionId}`;
			while (
				attempt < retryBudget &&
				outcome.failed === null &&
				!outcome.interrupted &&
				!handle.aborting &&
				!outcome.producedOutput &&
				!outcome.steered
			) {
				const transient = outcome.errors.find((error) => classifyProviderError(error.message) === "transient");
				if (!transient) break;
				attempt += 1;
				log("warn", "模型调用被打断，自动重试", {
					sessionId,
					attempt,
					maxAttempts: retryBudget,
					code: transient.code,
					message: transient.message,
				});
				// 只在「正在等待模型…」那一行显示（不走提示条：这一行一直挂到真的重新吐字为止，
				// 而提示条 4 秒就消失，退避期间反而以为卡死了）
				onEvent({ type: "retry", attempt, maxAttempts: retryBudget });
				await sleep(retryDelayMs(attempt));
				// 退避期间用户点了停止 → 别再折腾了
				if (handle.aborting) break;
				if (!omitFailedAttempt(handle, log, sessionId)) break;
				outcome = await runAttempt(attempt);
			}

			if (outcome.failed) {
				log("error", "这一轮没能发出去", { sessionId, message: outcome.failed.message });
				onEvent({ type: "error", code: outcome.failed.code, message: outcome.failed.message });
				onEvent({ type: "turn_end", reason: "error" });
				return;
			}
			// `handle.aborting` 是兵底：中断时它已经被 interrupt() 置 true，
			// 即使 agent_settled 没来得及到，也不要把「点停」报成「完成」
			const aborted = outcome.interrupted || handle.aborting;
			// 用户自己停的不再往界面上扔红条：他已经知道这一轮停了（日志里留一笔就够复盘）；
			// 真正失败（重试用尽 / 不可重试）才把最后那条错发出去。
			if (!aborted) {
				for (const error of outcome.errors) {
					onEvent({ type: "error", code: error.code, message: error.message });
				}
			}
			if (aborted) {
				log("info", "这一轮被中断", { sessionId, attempt });
			} else if (outcome.errors.length > 0) {
				log("error", "模型调用失败", { sessionId, attempt, message: outcome.errors.at(-1)?.message });
			} else if (attempt > 0) {
				log("info", "自动重试成功", { sessionId, attempt });
				onEvent({
					type: "notice",
					level: "info",
					key: retryNoticeKey,
					text: `模型调用已自动恢复（重试 ${attempt} 次）`,
				});
			}
			onEvent({ type: "turn_end", reason: aborted ? "interrupted" : outcome.errors.length > 0 ? "error" : "done" });
		},

		async interrupt(sessionId: string) {
			const handle = sessions.get(sessionId);
			if (!handle) return;
			handle.aborting = true;
			try {
				await handle.session.abort();
			} catch (error) {
				notice(`中断失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},

		async readTranscript(sessionId: string): Promise<EngineMessage[]> {
			const handle = sessions.get(sessionId);
			if (!handle) return [];
			return handle.session.messages.map((message) => {
				const record = asRecord(message);
				const content = asRecord(record.content);
				const text =
					typeof record.content === "string"
						? record.content
						: Array.isArray(content)
							? content
									.map((part) => {
										const item = asRecord(part);
										return typeof item.text === "string" ? item.text : "";
									})
									.join("")
							: "";
				const role = record.role === "assistant" ? "assistant" : "user";
				return { role, text, ts: typeof record.timestamp === "number" ? record.timestamp : Date.now() };
			});
		},

		setApprovalHandler(handler: ApprovalHandler) {
			approvalHandler = handler;
		},

		listProviderCatalog,

		async listModels(sessionId?: string) {
			// 模型注册表挂在会话的 modelRuntime 上：没有会话时给不出（界面在打开会话后才显示列表）
			const handle = sessionId ? sessions.get(sessionId) : [...sessions.values()].at(-1);
			const runtime = (handle?.session as { modelRuntime?: { getAvailable?: () => Promise<unknown[]> } } | undefined)
				?.modelRuntime;
			if (!runtime?.getAvailable) return [];
			try {
				const models = (await runtime.getAvailable()) as Array<{
					provider?: string;
					id?: string;
					name?: string;
					baseUrl?: string;
					api?: string;
				}>;
				const current = await this.currentModel?.(sessionId ?? "");
				return models
					.map((model) => {
						const id = `${String(model.provider ?? "?")}/${String(model.id ?? "?")}`;
						return {
							id,
							label: String(model.name ?? model.id ?? id),
							...(typeof model.baseUrl === "string" ? { baseUrl: model.baseUrl } : {}),
							...(typeof model.api === "string" ? { api: model.api } : {}),
							current: current ? id === `${current.provider}/${current.model}` : false,
						};
					})
					.sort((a, b) => Number(b.current) - Number(a.current) || a.id.localeCompare(b.id));
			} catch {
				return [];
			}
		},

		listThinkingLevels: thinking.listThinkingLevels,
		getThinkingLevel: thinking.getThinkingLevel,
		setThinkingLevel: thinking.setThinkingLevel,

		async switchModel(sessionId: string, modelId: string) {
			// ModelRuntime 上没有 find（那是 ModelRegistry 的方法）→ 从可用列表里自己匹配
			const handle = sessions.get(sessionId);
			const runtime = (handle?.session as { modelRuntime?: { getAvailable?: () => Promise<unknown[]> } } | undefined)
				?.modelRuntime;
			if (!handle || !runtime?.getAvailable) return false;
			const [provider, ...rest] = modelId.split("/");
			const wanted = rest.join("/");
			const available = (await runtime.getAvailable()) as Array<{ provider?: string; id?: string }>;
			const model = available.find((item) => String(item.provider) === provider && String(item.id) === wanted);
			if (!model) return false;
			try {
				await (handle.session as unknown as { setModel: (model: unknown) => Promise<void> }).setModel(model);
				return true;
			} catch (error) {
				options.onNotice?.(`切换模型失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return false;
			}
		},

		async currentModel(sessionId: string) {
			const handle = sessions.get(sessionId);
			const model = (handle?.session as { model?: { id?: string; provider?: string } } | undefined)?.model;
			if (!model) return null;
			return { provider: String(model.provider ?? "?"), model: String(model.id ?? "?") };
		},

		sessionModel: async (sessionId) => readSessionModel(sessions.get(sessionId)),

		async closeSession(sessionId: string) {
			const handle = sessions.get(sessionId);
			if (!handle) return;
			handle.unsubscribe();
			try {
				handle.session.dispose();
			} catch {
				// 已经关掉了
			}
			sessions.delete(sessionId);
		},

		/**
		 * 关会话：给了 id 就关那一个；**不给就是引擎级 dispose（切引擎时宿主就是这么调的）**，
		 * 把所有会话一起关掉。以前这个签名必填 sessionId，宿主 `dispose?.()` 传空 →
		 * `sessions.get(undefined)` 什么也没关，每切一次引擎就漏一批 SDK 会话与资源加载器。
		 */
		async dispose(sessionId?: string) {
			/**
			 * 引擎级 dispose（切引擎/退出）**必须连子代理一起收掉**。
			 *
			 * 子代理会话是 `pi-subagents` 自己 `createAgentSession` 起的，**不在下面这个 sessions map 里** ——
			 * 只关 sessions 就会漏掉它们：切走引擎后旧子代理还在跑（还在调工具、还在烧 token），
			 * 而且再也没人能把它们停下（宿主已经换了引擎，`interrupt_subagent` 会发给新引擎）。
			 */
			if (!sessionId && subagents.dispose) {
				try {
					await subagents.dispose();
				} catch {
					// 收不掉也不阻断切换（旧引擎的子代理最多多跑一会儿，但不会再阻塞切引擎）
				}
			}
			const ids = sessionId ? [sessionId] : [...sessions.keys()];
			for (const id of ids) {
				const handle = sessions.get(id);
				if (!handle) continue;
				handle.unsubscribe();
				try {
					handle.session.dispose();
				} catch {
					// 已经关掉了
				}
				sessions.delete(id);
			}
		},
	} as EnginePort;
}
