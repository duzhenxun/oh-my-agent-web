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
 *   - 中断：`session.abort()`；
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
import type { ApprovalHandler, EngineEvent, EngineMessage, EnginePort, EngineSessionOptions } from "./port.js";

export type PiSdkEngineOptions = {
	/** 引擎 SDK 的全局配置目录（默认 ~/.pi/agent，模型与凭据都在那里） */
	agentDir?: string;
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
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
	return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

/** 把工具结果里的文本抽出来（content 是 {type:"text",text} 数组） */
export function resultText(result: unknown): string {
	const content = asRecord(result).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** 把 bash 工具结果的退出码抠出来（不同工具 details 形状不同，取不到就不给） */
export function resultExitCode(result: unknown): number | undefined {
	const details = asRecord(asRecord(result).details);
	const value = details.exitCode ?? asRecord(asRecord(result).structuredContent).exitCode;
	return typeof value === "number" ? value : undefined;
}

/** 参数摘要（给界面与审批用） */
export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return args;
	try {
		const text = JSON.stringify(args ?? {});
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return "(无法序列化的参数)";
	}
}

/**
 * 纯函数：把 SDK 会话事件翻译成端口事件。返回 null 表示这个事件不影响 UI。
 * （单测用合成事件直接覆盖这张映射表 —— 不需要真的连模型。）
 */
export function mapSessionEvent(event: unknown): EngineEvent | null {
	const record = asRecord(event);
	const type = record.type;

	if (type === "message_update") {
		const assistantEvent = asRecord(record.assistantMessageEvent);
		if (
			assistantEvent.type === "text_delta" &&
			typeof assistantEvent.delta === "string" &&
			assistantEvent.delta !== ""
		) {
			return { type: "text_delta", text: assistantEvent.delta };
		}
		return null; // thinking_delta / tool_use 等：v1 不展示
	}

	if (type === "tool_execution_start") {
		const toolCallId = String(record.toolCallId ?? "");
		const name = String(record.toolName ?? "");
		return { type: "tool_start", toolCallId, name, argsSummary: summarizeArgs(record.args) };
	}

	if (type === "tool_execution_end") {
		const toolCallId = String(record.toolCallId ?? "");
		const exitCode = resultExitCode(record.result);
		return {
			type: "tool_end",
			toolCallId,
			status: record.isError === true ? "failed" : "ok",
			output: resultText(record.result),
			...(exitCode === undefined ? {} : { exitCode }),
		};
	}

	return null;
}

/**
 * 把宿主的纯文本历史转成 SDK 的会话条目（ADR-0018 的历史注入）。
 *
 * 为什么要它：我们的事实源是自家 JSONL（ADR-0005），SDK 侧是空会话；不喂历史，
 * 「重启后接着聊」时模型会**失忆**。这里构造最朴素的 user/assistant 文本条目 ——
 * 工具调用不重放（对连续性价值低、形状复杂），只保留对话主线。
 *
 * 纯函数：单测用合成历史直接覆盖，不需要连模型。
 */
export function historyEntries(history: EngineMessage[]): Array<Record<string, unknown>> {
	const now = Date.now();
	const entries: Array<Record<string, unknown>> = [];
	let parentId: string | null = null;

	history.forEach((message, index) => {
		if (message.text.trim() === "") return;
		const id = "seed-" + String(index);
		const ts = message.ts || now;
		const base = { type: "message", id, parentId, timestamp: new Date(ts).toISOString() };
		const content = [{ type: "text", text: message.text }];
		const entry =
			message.role === "user"
				? { ...base, message: { role: "user", content, timestamp: ts } }
				: {
						...base,
						message: {
							role: "assistant",
							content,
							// 以下字段是 SDK 的形状要求，但重放历史时无意义 → 用明确的占位值
							api: "replay",
							provider: "replay",
							model: "replay",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							stopReason: "stop",
							timestamp: ts,
						},
					};
		entries.push(entry);
		parentId = id;
	});

	return entries;
}

export function createPiSdkEngine(options: PiSdkEngineOptions = {}): EnginePort {
	const sessions = new Map<string, SessionHandle>();
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

	return {
		async createSession(sessionOptions: EngineSessionOptions) {
			// agentDir 是 SDK 的全局配置目录（模型与凭据都在那里）——默认 ~/.pi/agent
			const agentDir = options.agentDir ?? getAgentDir();
			const resourceLoader = new DefaultResourceLoader({
				cwd: sessionOptions.workspace,
				agentDir,
				extensionFactories: [makeApprovalExtension(sessionOptions.workspace)],
			});
			await resourceLoader.reload();

			// 历史注入（ADR-0018）：SDK 侧是空会话，不喂历史模型会失忆
			const seeded = historyEntries(sessionOptions.history ?? []);
			const sessionManager = SessionManager.inMemory(sessionOptions.workspace, {}, seeded as never);
			const { session } = await createAgentSession({
				cwd: sessionOptions.workspace,
				agentDir,
				resourceLoader,
				// 转录的事实源是我们自己的 JSONL（ADR-0005）→ 不让 SDK 再落一份
				sessionManager,
			});

			const handle: SessionHandle = {
				session: session as unknown as SessionHandle["session"],
				workspace: sessionOptions.workspace,
				unsubscribe: () => {},
				aborting: false,
			};
			sessions.set(sessionOptions.sessionId, handle);
		},

		async sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void) {
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
				await handle.session.prompt(text);
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

		async currentModel(sessionId: string) {
			const handle = sessions.get(sessionId);
			const model = (handle?.session as { model?: { id?: string; provider?: string } } | undefined)?.model;
			if (!model) return null;
			return { provider: String(model.provider ?? "?"), model: String(model.id ?? "?") };
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
