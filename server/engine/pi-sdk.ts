/**
 * 真实引擎：用 pi SDK 实现「引擎端口」（ADR-0003）。
 *
 * ⚠️ 这是**唯一**允许 import `@earendil-works/*` 的地方（守卫 `check-engine-imports.mjs` 强制）。
 * 业务代码只见 `port.ts` 里的类型。
 *
 * 与 SDK 的对接方式（M3 侦察结论）：
 *   - 建会话：`createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory() })`
 *     —— 会话转录的**事实源是我们自己的 JSONL**（ADR-0005），所以告诉 SDK 不要落盘；
 *   - 事件：`session.subscribe(listener)` → `message_update`（正文增量）/ `tool_execution_start|end`
 *     / `agent_end` / `agent_settled`（判断是否被中断）；
 *   - 读转录：`session.messages`；
 *   - **审批**：`DefaultResourceLoader({ extensionFactories: [...] })` 挂一个 inline 扩展，
 *     监听 `tool_call` 事件并 `await` 宿主的决定；拒绝时返回 `{ block: true, reason }`
 *     —— 这是 SDK 公开的拦截点，不需要改私有字段（对比参考实现的做法，这里选了更稳的路）。
 */
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { classifyScope } from "../approval/scope.js";
import { mapSessionEvent } from "./pi-events.js";
import { entriesToUiMessages } from "./pi-transcript.js";
import type { ApprovalHandler, EngineEvent, EngineMessage, EnginePort, EngineSessionOptions } from "./port.js";

export type PiSdkEngineOptions = {
	/** 引擎 SDK 的全局配置目录（默认 ~/.pi/agent，模型与凭据都在那里） */
	agentDir?: string;
	/**
	 * 会话存储目录（默认由 SDK 决定：`~/.pi/agent/sessions/<编码后的 cwd>/`）。
	 *
	 * **测试必须显式传临时目录** —— 否则会写进用户的真实会话存储。
	 * （真实教训：一次探针就直接落到了 `~/.pi/agent/sessions/` 里。）
	 */
	sessionDir?: string;
	/** 出问题时给宿主看的提示（不抛给用户，避免把一轮对话打死） */
	onNotice?: (text: string, level: "info" | "warn" | "error") => void;
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
	};
	workspace: string;
	unsubscribe: () => void;
	/** 正在被 abort（用来把 agent_settled 翻译成「中断」而不是「完成」） */
	aborting: boolean;
	/** 会话转录的管理器（ADR-0021 §2：读条目 → 界面消息） */
	sessionManager: { getEntries: () => unknown[]; getSessionFile: () => string | undefined };
	/** 会话文件路径（新建后由 SDK 告知；打开时即入参） */
	sessionPath: string | null;
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
	return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

/**
 * 教模型怎么写「下一步建议」（ADR-0022）。
 *
 * 刻意写得短：这段每次请求都要付 token，而细节交给解析器（它容忍各种畸形写法）。
 * 不写进 SDK 的工具提示词里 —— 与工具无关，是「回复的排版约定」。
 */
export const SUGGESTION_GUIDANCE = [
	"## Suggested next actions",
	"When the user must choose what to do next, end the reply with at most 3 lines of:",
	"[[action:suggest:<button text>]]",
	"Clicking a button sends that text as the next user message.",
	"Use [[action:suggest:<short label>,prompt=<text to send>]] when the label should differ from the sent text.",
	"Put them on their own lines at the very end, and never mention this syntax in prose.",
].join("\n");

import { createPiThinking } from "./pi-thinking.js";

export function createPiSdkEngine(options: PiSdkEngineOptions = {}): EnginePort {
	const sessions = new Map<string, SessionHandle>();
	const thinking = createPiThinking(sessions as unknown as Map<string, { session: unknown }>);
	let approvalHandler: ApprovalHandler | null = null;

	const notice = (text: string, level: "info" | "warn" | "error" = "warn") => options.onNotice?.(text, level);

	/** 审批用的 inline 扩展：拦在工具真正执行之前（SDK 的公开拦截点） */
	function makeApprovalExtension(workspace: string) {
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

	/** 建 resourceLoader 并拉起一个 AgentSession（createSession 与 openSession 共用） */
	async function startSession(
		sessionId: string,
		workspace: string,
		sessionManager: ReturnType<typeof SessionManager.inMemory>,
		sessionPath: string | null = null,
	): Promise<SessionHandle> {
		const agentDir = options.agentDir ?? getAgentDir();
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			extensionFactories: [makeApprovalExtension(workspace)],
			// 教模型「下一步建议」的写法（ADR-0022）：纯文本标记，不需要调用任何工具
			appendSystemPrompt: [SUGGESTION_GUIDANCE],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			resourceLoader,
			// ADR-0021 §2：转录的事实源就是 SDK 自己的会话文件（新建或打开的那个）
			sessionManager,
		});

		const handle: SessionHandle = {
			session: session as unknown as SessionHandle["session"],
			workspace,
			unsubscribe: () => {},
			aborting: false,
			sessionManager: sessionManager as unknown as SessionHandle["sessionManager"],
			sessionPath: sessionPath ?? sessionManager.getSessionFile() ?? null,
		};
		sessions.set(sessionId, handle);
		return handle;
	}

	const PREWARM_ID = "__prewarm__";
	return {
		/** 预热模型注册表（内存会话，不落盘）：pi 的 modelRuntime 挂在会话上，没会话就列不出模型 */
		async prewarm() {
			if (sessions.has(PREWARM_ID)) return;
			try {
				await startSession(PREWARM_ID, process.cwd(), SessionManager.inMemory());
			} catch (error) {
				options.onNotice?.(
					`模型表预热失败（内置 provider 可能列表不全）：${error instanceof Error ? error.message : String(error)}`,
					"warn",
				);
			}
		},

		async createSession(sessionOptions: EngineSessionOptions) {
			// ADR-0021 §2：新建会话就落在 **pi 的会话存储**里（不再用 inMemory + 自建 jsonl），
			// 用我们的 sessionId 当 SDK 的会话 id → 两边 id 空间完全一致。
			const sessionManager = SessionManager.create(sessionOptions.workspace, options.sessionDir, {
				id: sessionOptions.sessionId,
			});
			const handle = await startSession(sessionOptions.sessionId, sessionOptions.workspace, sessionManager);
			return { sessionPath: handle.sessionPath };
		},

		async openSession(openOptions) {
			// SessionManager.open 会读首行 header 拿到 cwd，并把后续写入追加回**同一个文件**
			const sessionManager = SessionManager.open(openOptions.sessionPath, options.sessionDir);
			const workspace = sessionManager.getCwd() || process.cwd();
			await startSession(openOptions.sessionId, workspace, sessionManager, openOptions.sessionPath);
		},

		async readUiMessages(sessionId: string) {
			const handle = sessions.get(sessionId);
			if (!handle) return [];
			return entriesToUiMessages(handle.sessionManager.getEntries());
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
			const handle = sessions.get(sessionId);
			if (!handle) {
				onEvent({ type: "error", code: "engine.no_session", message: `引擎里没有这个会话：${sessionId}` });
				onEvent({ type: "turn_end", reason: "error" });
				return;
			}

			handle.aborting = false;
			let interrupted = false;
			let failed: { code: string; message: string } | null = null;
			let settled: Promise<void> | null = null;
			let markSettled: (() => void) | null = null;
			settled = new Promise<void>((resolve) => {
				markSettled = resolve;
			});

			handle.unsubscribe = handle.session.subscribe((event: unknown) => {
				const mapped = mapSessionEvent(event);
				if (mapped) {
					onEvent(mapped);
					return;
				}
				const record = asRecord(event);
				if (record.type === "agent_settled") {
					interrupted = record.aborted === true || handle.aborting;
					markSettled?.();
				}
			});

			try {
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
				await (
					handle.session as unknown as { prompt: (text: string, options: typeof promptOptions) => Promise<void> }
				).prompt(text, promptOptions);
				// 等 settle：prompt() 返回后仍可能有收尾事件
				await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 50))]);
			} catch (error) {
				failed = {
					code: "engine.prompt_failed",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				handle.unsubscribe();
				handle.unsubscribe = () => {};
			}

			if (failed) {
				onEvent({ type: "error", code: failed.code, message: failed.message });
				onEvent({ type: "turn_end", reason: "error" });
				return;
			}
			onEvent({ type: "turn_end", reason: interrupted ? "interrupted" : "done" });
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

		// 关掉一个会话（宿主换会话/退出时用）
		async dispose(sessionId: string) {
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
	} as EnginePort & { dispose: (sessionId: string) => Promise<void> };
}
