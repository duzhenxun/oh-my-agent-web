/**
 * codex 引擎适配（ADR-0024 的第二个真实引擎，细节见 ADR-0036）。
 *
 * 全部能力都来自 codex 自己的本地服务（`codex app-server`）：建会话 thread/start、续聊 resume、
 * 说话 turn/start、改名 name/set、历史 turns/list、模型 model/list + settings/update、审批回服务端请求。
 * **不读写 codex 的数据库 / rollout**，所以 Codex Desktop 与工作台看到的是同一批会话。
 *
 * 与 pi 的差异（如实写进能力矩阵）：句柄是 threadId；审批是命令/文件级；图片附件暂不支持。
 */
import type {
	ApprovalHandler,
	EngineEvent,
	EngineMessage,
	EngineModelInfo,
	EngineOpenOptions,
	EnginePort,
	EngineSessionOptions,
} from "./port.js";
import {
	friendlyCodexError,
	itemsToTranscript,
	itemsToUiMessages,
	mapModels,
	thinkingLevelsOf,
	toolEndOf,
	toolStartOf,
	turnTs,
	type CodexItem,
	type CodexModel,
	type CodexTurn,
} from "./codex-map.js";
import { createCodexClient, type CodexClient, type CodexNotification } from "./codex-transport.js";
import { registerCodexApprovals } from "./codex-approvals.js";
import { sanitizeHistoricalActions } from "../markers/actions.js";
import { ensureCodexProject } from "./codex-sessions.js";

type Binding = {
	threadId: string;
	workspace: string;
	/** 这个 thread 在本进程里是否已「加载」（新建过 / resume 过）；没加载过要先 resume 才能开回合 */
	live: boolean;
};

type ActiveTurn = {
	turnId: string | null;
	onEvent: (event: EngineEvent) => void;
	finish: () => void;
	ended: boolean;
};

export type CodexEngineOptions = {
	/** 共享的 app-server 客户端（会话清单提供者复用同一个进程） */
	client?: CodexClient;
	bin?: string;
	home?: string;
	log?: (text: string) => void;
};

export type CodexEngine = EnginePort & {
	/** 会话清单提供者要跟引擎共用这一个客户端 */
	client: CodexClient;
};

export function createCodexEngine(options: CodexEngineOptions = {}): CodexEngine {
	const client =
		options.client ?? createCodexClient({ bin: options.bin, home: options.home, log: options.log ?? (() => {}) });
	const bindings = new Map<string, Binding>();
	const byThread = new Map<string, string>();
	const active = new Map<string, ActiveTurn>();
	let models: CodexModel[] | null = null;
	let approvalHandler: ApprovalHandler | null = null;
	/** 最近一次可预期失败的原因（给界面用，见 EnginePort.lastError） */
	let lastError: string | null = null;

	const threadOf = (sessionId: string): Binding | null => {
		const binding = bindings.get(sessionId);
		if (binding) return binding;
		// 历史会话：侧栏给的 id 就是 threadId（provider 保证），直接认
		if (/^[0-9a-f-]{36}$/i.test(sessionId)) {
			const adopted: Binding = { threadId: sessionId, workspace: "", live: false };
			bindings.set(sessionId, adopted);
			byThread.set(sessionId, sessionId);
			return adopted;
		}
		return null;
	};

	const loadModels = async (): Promise<CodexModel[]> => {
		if (models) return models;
		const result = await client.request<{ data?: CodexModel[] }>("model/list", {});
		models = result?.data ?? [];
		return models;
	};

	const handleNotification = (notification: CodexNotification): void => {
		const params = notification.params;
		const threadId = typeof params.threadId === "string" ? params.threadId : "";
		const conversationId = byThread.get(threadId);
		const turn = conversationId ? active.get(conversationId) : undefined;
		const emit = (event: EngineEvent): void => {
			if (turn && !turn.ended) turn.onEvent(event);
		};

		switch (notification.method) {
			case "item/agentMessage/delta":
				emit({ type: "text_delta", text: typeof params.delta === "string" ? params.delta : "" });
				return;
			case "item/reasoning/textDelta":
			case "item/reasoning/summaryTextDelta":
				emit({ type: "thinking_delta", text: typeof params.delta === "string" ? params.delta : "" });
				return;
			case "item/started": {
				const event = toolStartOf((params.item ?? {}) as CodexItem);
				if (event) emit(event);
				return;
			}
			case "item/completed": {
				const event = toolEndOf((params.item ?? {}) as CodexItem);
				if (event) emit(event);
				return;
			}
			case "thread/tokenUsage/updated": {
				const usage = params.tokenUsage as
					| {
							last?: {
								inputTokens?: number;
								cachedInputTokens?: number;
								cacheWriteInputTokens?: number;
								outputTokens?: number;
							};
					  }
					| undefined;
				const last = usage?.last;
				if (!last) return;
				emit({
					type: "usage",
					input: last.inputTokens ?? 0,
					output: last.outputTokens ?? 0,
					cacheRead: last.cachedInputTokens ?? 0,
					cacheWrite: last.cacheWriteInputTokens ?? 0,
				});
				return;
			}
			case "turn/completed": {
				if (!turn) return;
				const completed = (params.turn ?? {}) as { id?: string; status?: string };
				if (turn.turnId && completed.id && completed.id !== turn.turnId) return;
				const reason =
					completed.status === "interrupted" ? "interrupted" : completed.status === "failed" ? "error" : "done";
				emit({ type: "turn_end", reason });
				turn.ended = true;
				turn.finish();
				return;
			}
			case "error": {
				// willRetry=true 是 codex 内部的瞬时重试（断流、429…）：不该在对话里留一条红色错误
				if (params.willRetry === true) return;
				const error = params.error as { message?: string } | undefined;
				const message = error?.message ?? "codex 报错";
				emit({ type: "error", code: "engine.codex_error", message });
				if (turn) {
					emit({ type: "turn_end", reason: "error" });
					turn.ended = true;
					turn.finish();
				}
				return;
			}
			default:
				return;
		}
	};

	client.onNotification(handleNotification);
	registerCodexApprovals({ client, getHandler: () => approvalHandler });

	/** 当前模型（provider/model 口径）：thread/read 是最准的来源 */
	const currentModelOf = async (sessionId: string) => {
		const binding = threadOf(sessionId);
		if (!binding) return null;
		const result = await client.request<{ thread?: { model?: string | null; modelProvider?: string | null } }>(
			"thread/read",
			{ threadId: binding.threadId },
		);
		const model = result?.thread?.model ?? null;
		if (!model) return null;
		// provider 留空 = 「id 本身就是全名」：codex 的模型 id 就是 slug，界面上不该显示 `codex/xxx`
		return { provider: "", model };
	};

	/** 读最近若干轮（codex 默认倒序分页 → 翻正序；40 轮够对话区与侧栏用） */
	const loadTurns = async (sessionId: string): Promise<CodexTurn[]> => {
		const binding = threadOf(sessionId);
		if (!binding) return [];
		const result = await client.request<{ data?: CodexTurn[] }>("thread/turns/list", {
			threadId: binding.threadId,
			limit: 40,
			sortDirection: "desc",
		});
		return [...(result?.data ?? [])].reverse();
	};

	/** 确保这个会话对应的 thread 已加载（历史会话要先 resume，否则无法开回合 / 改设置） */
	const ensureLive = async (sessionId: string): Promise<Binding | null> => {
		const binding = threadOf(sessionId);
		if (!binding) return null;
		if (binding.live) return binding;
		await client.request("thread/resume", { threadId: binding.threadId, excludeTurns: true });
		binding.live = true;
		return binding;
	};

	return {
		client,
		version: () => client.version(),

		async createSession(sessionOptions: EngineSessionOptions) {
			// 对齐原生：新会话落在 codex 的 project 里（没有就建一个，幂等键按目录）
			const projectId = await ensureCodexProject(client, sessionOptions.workspace);
			const response = await client.request<{ thread?: { id?: string } }>("thread/start", {
				cwd: sessionOptions.workspace,
				...(projectId ? { projectId } : {}),
			});
			const threadId = response?.thread?.id;
			if (!threadId) throw new Error("codex 没有返回 thread id");
			const binding: Binding = { threadId, workspace: sessionOptions.workspace, live: true };
			bindings.set(sessionOptions.sessionId, binding);
			byThread.set(threadId, sessionOptions.sessionId);
			return { sessionPath: null, engineSessionId: threadId };
		},

		async openSession(openOptions: EngineOpenOptions) {
			const threadId = openOptions.engineSessionId ?? openOptions.sessionPath ?? openOptions.sessionId;
			const binding: Binding = { threadId, workspace: "", live: false };
			bindings.set(openOptions.sessionId, binding);
			byThread.set(threadId, openOptions.sessionId);
			// 不在打开时 resume：历史会话常常只需要读；真要发消息时再 resume（少一次加载）
		},

		async sendMessage(sessionId, text, onEvent) {
			const binding = await ensureLive(sessionId).catch((error: unknown) => {
				throw new Error(friendlyCodexError(error));
			});
			if (!binding) throw new Error("codex 会话还没准备好（先新建或打开一个会话）");

			let finish = (): void => {};
			const done = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const turn: ActiveTurn = { turnId: null, onEvent, finish, ended: false };
			active.set(sessionId, turn);
			try {
				const response = await client.request<{ turn?: { id?: string } }>(
					"turn/start",
					{ threadId: binding.threadId, input: [{ type: "text", text, text_elements: [] }] },
					{ timeoutMs: 120_000 },
				);
				turn.turnId = response?.turn?.id ?? null;
				await done;
			} finally {
				turn.ended = true;
				active.delete(sessionId);
			}
		},

		async interrupt(sessionId) {
			const binding = threadOf(sessionId);
			const turn = active.get(sessionId);
			if (!binding || !turn?.turnId) return;
			// 停止按钮是 fire-and-forget（看门狗也会直接 void 调它）：RPC 失败不能让
			// Promise 拒绝一路飘到进程级（Node 默认会直接把服务带走）。
			try {
				await client.request("turn/interrupt", { threadId: binding.threadId, turnId: turn.turnId });
			} catch (error) {
				// 只记日志：停止失败最坏是「这一轮继续跑」，不该把进程一起带走
				options.log?.(`停止失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},

		async closeSession(sessionId) {
			const binding = bindings.get(sessionId);
			bindings.delete(sessionId);
			if (!binding) return;
			byThread.delete(binding.threadId);
			await client.request("thread/unsubscribe", { threadId: binding.threadId }).catch(() => undefined);
		},

		async readUiMessages(sessionId) {
			const turns = await loadTurns(sessionId);
			const now = Date.now();
			return sanitizeHistoricalActions(turns.flatMap((turn) => itemsToUiMessages(turn.items ?? [], turnTs(turn, now))));
		},

		async readTranscript(sessionId) {
			const turns = await loadTurns(sessionId);
			const now = Date.now();
			return turns.flatMap((turn): EngineMessage[] => itemsToTranscript(turn.items ?? [], turnTs(turn, now)));
		},

		renameSession: (handle, name) =>
			client.request("thread/name/set", { threadId: handle, name }).then(() => undefined),

		deleteSession: (handle) => client.request("thread/delete", { threadId: handle }).then(() => undefined),

		/**
		 * 不看了就放开写锁（`thread/unsubscribe`）：Codex 桌面端随即可以打开这条会话。
		 * 下次再发消息会重新 resume（几毫秒），换来「两端不会互相锁死」。
		 */
		async parkSession(sessionId) {
			const binding = bindings.get(sessionId);
			if (!binding || !binding.live) return;
			binding.live = false;
			await client.request("thread/unsubscribe", { threadId: binding.threadId }).catch(() => undefined);
		},

		/**
		 * 换引擎 / 退出：关掉 app-server 子进程。
		 * 它持有我们 resume 过的**全部** thread 的写锁，不关就会一直挡着 Codex 桌面端。
		 */
		async dispose() {
			bindings.clear();
			byThread.clear();
			active.clear();
			models = null;
			client.close();
		},

		setApprovalHandler(handler) {
			approvalHandler = handler;
		},

		async prewarm() {
			await client.ensureStarted();
			await loadModels().catch(() => []); // 模型表拿不到不影响会话，只是下拉为空
		},
		reloadModels: async () => {
			models = null;
		},

		async listModels(): Promise<EngineModelInfo[]> {
			return mapModels(await loadModels());
		},

		currentModel: currentModelOf,
		sessionModel: currentModelOf,

		async switchModel(sessionId, modelId) {
			lastError = null;
			try {
				// 历史会话要先 resume：没加载的 thread 改不了设置，发回合也不行
				const binding = await ensureLive(sessionId);
				if (!binding) {
					lastError = "先打开一个会话";
					return false;
				}
				await client.request("thread/settings/update", { threadId: binding.threadId, model: modelId });
				return true;
			} catch (error) {
				lastError = friendlyCodexError(error);
				return false;
			}
		},

		lastError: () => lastError,

		async listThinkingLevels(sessionId) {
			const catalog = await loadModels().catch(() => [] as CodexModel[]);
			return thinkingLevelsOf(catalog, sessionId ? ((await currentModelOf(sessionId))?.model ?? null) : null);
		},

		async getThinkingLevel(sessionId) {
			if (!sessionId) return null;
			const binding = threadOf(sessionId);
			if (!binding) return null;
			const result = await client.request<{ thread?: { reasoningEffort?: string | null } }>("thread/read", {
				threadId: binding.threadId,
			});
			return result?.thread?.reasoningEffort ?? null;
		},

		async setThinkingLevel(sessionId, level) {
			lastError = null;
			try {
				const binding = await ensureLive(sessionId);
				if (!binding) {
					lastError = "先打开一个会话";
					return false;
				}
				await client.request("thread/settings/update", { threadId: binding.threadId, effort: level });
				return true;
			} catch (error) {
				lastError = friendlyCodexError(error);
				return false;
			}
		},
	};
}
