/**
 * Claude Code 引擎适配（ADR-0044）—— ACP 客户端实现 EnginePort。
 *
 * 映射一览（细节与实测依据见 claude-map.ts / claude-sessions.ts 文件头）：
 *   建会话   → `session/new {cwd, mcpServers}`   → sessionId + models（模型表）+ modes
 *   续接     → `session/resume {sessionId, cwd}`（ACP 的 resume 不重放历史；拿不到就退回 `session/load`）
 *   说话     → `session/prompt`，期间收 `session/update`（正文 / 思考 / 工具）
 *   打断     → `session/cancel`（**通知**，不是请求）
 *   换模型   → `session/set_model {sessionId, modelId}`（Claude 没有 configOptions，这一点与 opencode 不同）
 *   权限     → 服务端请求 `session/request_permission` → 我们的审批弹窗
 *   历史/统计 → 直接读 `~/.claude/projects/<cwd>/<sid>.jsonl`（`session/prompt` 不返回 usage）
 *
 * 已知边界（如实声明，界面据此隐藏控件）：
 *   - **没有思考档位**：这套 ACP 面里 Claude 不暴露 thinking/effort（`availableModes` 是权限模式，
 *     不是思考档）→ `thinkingLevel: false`，界面上没有那个控件；
 *   - **没有 steer**（回合中插队）：ACP 没有这个语义 → 宿主按普通一轮排队；
 *   - **没有子代理面板**：Claude 的 Task 子代理在 ACP 里就是一张工具卡片（`kind:"think"`），
 *     拿不到「谁在跑」的运行视图 → `subagents` 不实现；
 *   - **不能改会话名 / 不能 plan 模式切换**：ACP 这边没有 rename 方法；`session/set_mode`
 *     虽然存在，但 port 没有「模式」这个概念（切了要在界面上有对应控件才不算骗人）→ 不接。
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
	CLAUDE_PROVIDER,
	currentModelId,
	currentModelOf,
	friendlyClaudeError,
	isFinalToolStatus,
	modelIdFor,
	modelOptions,
	permissionApprovalRequest,
	permissionOptionId,
	stopReasonToTurnEnd,
	textEventOf,
	toolEndEvent,
	toolFactsOf,
	toolStartEvent,
	type ClaudeModels,
	type ClaudePermissionRequest,
	type ClaudePromptResult,
	type ClaudeSessionResult,
	type ClaudeUpdate,
	type ToolFacts,
} from "./claude-map.js";
import {
	claudeSessionFile,
	deleteClaudeSession,
	lastTurnUsage,
	readTranscriptFile,
	sessionModelOf,
	transcriptStats,
	transcriptToTranscript,
	transcriptToUiMessages,
} from "./claude-sessions.js";
import { createClaudeClient, defaultClaudeBin, type ClaudeClient } from "./claude-transport.js";
import { withProbeCwd } from "./catalog-probe.js";
import { isScratchCwd } from "./scratch.js";

type Binding = {
	engineSessionId: string;
	cwd: string;
	live: boolean;
	/** 会话文件（打开历史会话时宿主给的路径；新建会话要等 Claude 落盘后才找得到） */
	sessionPath: string | null;
	models: ClaudeModels;
};

type ActiveTurn = {
	onEvent: (event: EngineEvent) => void;
	ended: boolean;
	/** 已经开过卡片的 toolCallId（`tool_call_update` 会重复推同一条） */
	started: Set<string>;
	/** 已经收口的 toolCallId（重复的 completed 不要再发一次 tool_end） */
	finished: Set<string>;
};

type ClaudeEngineOptions = {
	/** 共享的 ACP 客户端（历史清单不依赖它，但宿主可复用同一个子进程） */
	client?: ClaudeClient;
	bin?: string;
	args?: string[];
	/** 新会话优先用的模型（`anthropic/opus` 或裸别名 `opus`）；不给就尊重 Claude 自己的默认 */
	model?: string | null;
	log?: (text: string) => void;
	/** Claude 数据目录（`CLAUDE_CONFIG_DIR`）；不给就用 ~/.claude */
	home?: string;
};

type ClaudeEngine = EnginePort & { client: ClaudeClient };

const MAX_TOOL_FACTS = 200;
/** 回合结束后多久内「读统计」要等一下再读：Claude 是边聊边写 JSONL，最后一条可能还没落盘 */
const SETTLE_MS = 3000;

export function createClaudeEngine(options: ClaudeEngineOptions = {}): ClaudeEngine {
	const bin = options.bin ?? defaultClaudeBin();
	const client = options.client ?? createClaudeClient({ bin, args: options.args, log: options.log ?? (() => {}) });

	const bindings = new Map<string, Binding>();
	const byEngineSession = new Map<string, string>();
	const active = new Map<string, ActiveTurn>();
	/** toolCallId → 工具事实（权限请求兜底用：请求体里只有 title，没有真工具名） */
	const toolFacts = new Map<string, ToolFacts>();
	/** conversationId → 最近一次回合结束的时刻（用于 SETTLE_MS 的等待） */
	const settledAt = new Map<string, number>();
	let approvalHandler: ApprovalHandler | null = null;
	let lastError: string | null = null;
	/**
	 * 最近一次拿到的模型表。历史会话在 resume 之前没有 models，但选择器不该是空的 ——
	 * 用它兜底；真正切模型时仍会先 resume（拿不到就报可读错误）。
	 */
	let lastModels: ClaudeModels = {};
	/** 目录探针跑过没有（每个实例只探一次；`reloadModels` / `dispose` 重置） */
	let catalogProbed = false;

	const rememberTool = (facts: ToolFacts): void => {
		const previous = toolFacts.get(facts.toolCallId);
		// 后到的 update 更详细（title 从占位变成真命令），合并而不是覆盖
		toolFacts.set(facts.toolCallId, { ...previous, ...facts });
		if (toolFacts.size > MAX_TOOL_FACTS) {
			const oldest = toolFacts.keys().next().value;
			if (oldest) toolFacts.delete(oldest);
		}
	};

	const applyModels = (binding: Binding | undefined, models: ClaudeModels | undefined): void => {
		if (!models) return;
		lastModels = models;
		if (binding) binding.models = models;
	};

	const bindingOf = (conversationId: string): Binding | null => bindings.get(conversationId) ?? null;

	const anyModels = (conversationId?: string): ClaudeModels => {
		const binding = conversationId ? bindingOf(conversationId) : undefined;
		if (binding && (binding.models.availableModels?.length ?? 0) > 0) return binding.models;
		const found = [...bindings.values()].find((item) => (item.models.availableModels?.length ?? 0) > 0);
		return found?.models ?? lastModels;
	};

	/**
	 * 没有会话时把模型表弄进来（原因与代价见 catalog-probe.ts 文件头）：
	 * Claude 的模型只在 `session/new` 的 `models` 里 → 开个临时会话抄一份，再删掉它的 JSONL。
	 * 这套 ACP 面没有 `session/close`（parkSession 也知道这一点），所以收尾只能走文件。
	 */
	const warmCatalog = async (): Promise<void> => {
		if (catalogProbed || (lastModels.availableModels?.length ?? 0) > 0) return;
		catalogProbed = true;
		await withProbeCwd(async (cwd) => {
			const created = await client.request<ClaudeSessionResult>("session/new", { cwd, mcpServers: [] });
			const probeId = created?.sessionId;
			if (!probeId) return;
			applyModels(undefined, created.models);
			// 会话文件是**第一次说话时**才写的：找不到文件就是本来没留下东西（不该报警告）
			const file = claudeSessionFile(probeId, { cwd, home: options.home });
			if (file && !deleteClaudeSession(probeId, { home: options.home, cwd, sessionPath: file })) {
				options.log?.(`claude：模型目录探针会话的文件没删掉：${file}`);
			}
		});
	};

	/** 会话文件：宿主给的路径优先，否则按 cwd 猜 / 扫目录 */
	const fileOf = (conversationId: string): string | null => {
		const binding = bindingOf(conversationId);
		if (!binding) return null;
		if (binding.sessionPath) return binding.sessionPath;
		const found = claudeSessionFile(binding.engineSessionId, { cwd: binding.cwd, home: options.home });
		if (found) binding.sessionPath = found;
		return found;
	};

	const entriesOf = (conversationId: string) => {
		const file = fileOf(conversationId);
		return file ? readTranscriptFile(file) : [];
	};

	/**
	 * 历史会话首次使用时才 resume（ACP 的 resume 会挂一个活的 query）。
	 *
	 * 代价写在这里：**resume 之前这条会话的模型表是空的**（模型表只能从 `session/new|resume` 拿），
	 * 所以刚启动工作台就直接看历史会话时，模型选择器要等第一轮消息（resume）之后才有内容 ——
	 * 与 opencode 一致，不是一个可以在不挂活句柄的前提下解的问题。
	 *
	 * `session/load` 是备用路径：老版本适配器只注册了 load，它会**重放历史** ——
	 * 重放发生在 request 返回之前，此时该会话还没有 active turn，事件会被丢掉（不会串到界面里）。
	 */
	const ensureLive = async (conversationId: string): Promise<Binding | null> => {
		const binding = bindingOf(conversationId);
		if (!binding) return null;
		if (binding.live) return binding;
		const params = { sessionId: binding.engineSessionId, cwd: binding.cwd, mcpServers: [] };
		const resume = (method: string) =>
			client.request<ClaudeSessionResult>(method, params, { timeoutMs: 120_000 }).catch((error: unknown) => {
				throw error;
			});
		try {
			applyModels(binding, (await resume("session/resume"))?.models);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/method not found|not implemented|-32601/i.test(message)) throw error;
			options.log?.(`claude：session/resume 不可用，退回 session/load（${message.slice(0, 120)}）`);
			applyModels(binding, (await resume("session/load"))?.models);
		}
		binding.live = true;
		return binding;
	};

	const handleToolUpdate = (conversationId: string, update: ClaudeUpdate): void => {
		const facts = toolFactsOf(update);
		if (!facts) return;
		rememberTool(facts);
		const merged = toolFacts.get(facts.toolCallId) ?? facts;

		const turn = active.get(conversationId);
		if (!turn || turn.ended) return;

		// Claude 的 tool_call 第一条就带齐了 rawInput，不需要像 opencode 那样等第二条
		if (!turn.started.has(facts.toolCallId)) {
			turn.started.add(facts.toolCallId);
			turn.onEvent(toolStartEvent(merged));
		}
		if (!isFinalToolStatus(update.status) || turn.finished.has(facts.toolCallId)) return;
		turn.finished.add(facts.toolCallId);
		turn.onEvent(toolEndEvent(update));
	};

	const handleNotification = (notification: { method: string; params: Record<string, unknown> }): void => {
		if (notification.method !== "session/update") return;
		const params = notification.params;
		const engineSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		const conversationId = byEngineSession.get(engineSessionId);
		if (!conversationId) return;
		const update = (params.update ?? {}) as ClaudeUpdate;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			handleToolUpdate(conversationId, update);
			return;
		}
		const event = textEventOf(update);
		if (!event) return;
		const turn = active.get(conversationId);
		if (turn && !turn.ended) turn.onEvent(event);
	};

	const handlePermission = async (id: number, params: ClaudePermissionRequest): Promise<void> => {
		const toolCallId = params.toolCall?.toolCallId;
		const facts = typeof toolCallId === "string" ? toolFacts.get(toolCallId) : undefined;
		// 带上会话归属：宿主收尾时只收这个会话的审批（不然会误伤并行会话，见 approval-bridge）
		const owner = params.sessionId ? byEngineSession.get(params.sessionId) : undefined;
		const request = { ...permissionApprovalRequest(params, facts), ...(owner ? { conversationId: owner } : {}) };
		let decision: "once" | "always" | "deny" = "deny";
		if (approvalHandler) {
			try {
				decision = await approvalHandler(request);
			} catch {
				decision = "deny";
			}
		}
		client.respond(id, {
			outcome: { outcome: "selected", optionId: permissionOptionId(params.options, decision) },
		});
	};

	client.onNotification(handleNotification);
	client.onServerRequest((request) => {
		if (request.method === "session/request_permission") {
			void handlePermission(request.id, request.params as ClaudePermissionRequest);
			return;
		}
		// 认不出的服务端请求必须回包，否则 Claude 那一轮会一直等
		client.respondError(request.id, -32601, `agent-web 未实现的服务端请求：${request.method}`);
	});

	const engine: ClaudeEngine = {
		client,
		version: () => client.version(),

		async prewarm() {
			await client.ensureStarted();
			// 顺手把模型表也弄进来：否则切过来、还没开会话时下拉是空的（见 catalog-probe.ts）
			await warmCatalog().catch((error: unknown) => {
				options.log?.(`claude：读取模型目录失败：${error instanceof Error ? error.message : String(error)}`);
			});
		},

		/** 重读模型表（改完 Claude 自己的配置后）：清掉快照，重新探一次 */
		async reloadModels() {
			lastModels = {};
			catalogProbed = false;
			await warmCatalog().catch((error: unknown) => {
				options.log?.(`claude：重读模型目录失败：${error instanceof Error ? error.message : String(error)}`);
			});
		},

		async createSession(sessionOptions: EngineSessionOptions) {
			const created = await client
				.request<ClaudeSessionResult>(
					"session/new",
					{ cwd: sessionOptions.workspace, mcpServers: [] },
					{ timeoutMs: 120_000 },
				)
				.catch((error: unknown) => {
					throw new Error(friendlyClaudeError(error));
				});
			const engineSessionId = created?.sessionId;
			if (!engineSessionId) throw new Error("Claude Code 没有返回 sessionId");
			const binding: Binding = {
				engineSessionId,
				cwd: sessionOptions.workspace,
				live: true,
				sessionPath: null,
				models: created.models ?? {},
			};
			bindings.set(sessionOptions.sessionId, binding);
			byEngineSession.set(engineSessionId, sessionOptions.sessionId);
			applyModels(binding, created.models);

			// 默认模型：只尊重显式配置（AGENT_WEB_CLAUDE_MODEL），否则用 Claude 自己的默认
			const wanted = options.model?.trim();
			if (wanted) {
				const modelId = modelIdFor(binding.models, wanted);
				if (modelId === null) {
					options.log?.(`claude：默认模型不在可选列表里，已忽略：${wanted}`);
				} else if (modelId !== currentModelId(binding.models)) {
					await client.request("session/set_model", { sessionId: engineSessionId, modelId }).catch((error: unknown) => {
						options.log?.(`claude：设置默认模型失败（${wanted}）：${friendlyClaudeError(error)}`);
					});
					applyModels(binding, { ...binding.models, currentModelId: modelId });
				}
			}
			return { sessionPath: null, engineSessionId };
		},

		async openSession(openOptions: EngineOpenOptions) {
			const engineSessionId = openOptions.engineSessionId ?? openOptions.sessionPath ?? openOptions.sessionId;
			const binding: Binding = {
				engineSessionId,
				cwd: openOptions.cwd ?? "",
				live: false,
				sessionPath: openOptions.sessionPath ?? null,
				models: {},
			};
			bindings.set(openOptions.sessionId, binding);
			byEngineSession.set(engineSessionId, openOptions.sessionId);
		},

		async sendMessage(sessionId, text, onEvent, sendOptions) {
			const binding = await ensureLive(sessionId).catch((error: unknown) => {
				throw new Error(friendlyClaudeError(error));
			});
			if (!binding) throw new Error("Claude Code 会话还没准备好（先新建一个会话）");

			const turn: ActiveTurn = { onEvent, ended: false, started: new Set(), finished: new Set() };
			active.set(sessionId, turn);

			const model = currentModelId(binding.models);
			if (model) onEvent({ type: "model", model: `${CLAUDE_PROVIDER}/${model}` });

			// ACP 的图片注入：适配器声明了 promptCapabilities.image = true（实测）
			const prompt: Array<Record<string, unknown>> = [];
			if (text.trim() !== "") prompt.push({ type: "text", text });
			for (const image of sendOptions?.images ?? []) {
				prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}
			if (prompt.length === 0) {
				active.delete(sessionId);
				throw new Error("这条消息是空的（没有文本也没有图片）");
			}

			try {
				const result = await client.request<ClaudePromptResult>(
					"session/prompt",
					{ sessionId: binding.engineSessionId, prompt },
					// 一轮跑很久是正常的（有工具调用）：给 30 分钟，别用默认 30 秒掐掉
					{ timeoutMs: 30 * 60 * 1000 },
				);
				settledAt.set(sessionId, Date.now());
				// `session/prompt` 不返回 usage：从 JSONL 里把这一轮加起来，界面上的 token 才会动
				const usage = lastTurnUsage(entriesOf(sessionId));
				if (usage && !turn.ended) onEvent({ type: "usage", ...usage, final: true });
				if (!turn.ended) onEvent({ type: "turn_end", reason: stopReasonToTurnEnd(result?.stopReason) });
			} catch (error) {
				throw new Error(friendlyClaudeError(error));
			} finally {
				turn.ended = true;
				active.delete(sessionId);
			}
		},

		async interrupt(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding) return;
			// ACP 里 cancel 是**通知**（无 id）：发成请求会被当成未知方法丢掉 → 停止按钮没反应
			client.notify("session/cancel", { sessionId: binding.engineSessionId });
		},

		/** 「暂时不看了」：Claude 这套 ACP 面没有 close 方法，只需要停用绑定（resume 很便宜） */
		async parkSession(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding) return;
			binding.live = false;
		},

		async closeSession(sessionId) {
			const binding = bindingOf(sessionId);
			bindings.delete(sessionId);
			if (binding) byEngineSession.delete(binding.engineSessionId);
		},

		async dispose() {
			// 注意：**不清 lastModels** —— 它只是「Claude 有哪些模型」的目录快照，
			// 切走再切回时模型选择器不该空着；真正切模型时会先 resume 拿最新模型表。
			bindings.clear();
			byEngineSession.clear();
			active.clear();
			toolFacts.clear();
			settledAt.clear();
			catalogProbed = false; // 探针会话随适配器进程一起没了：下次切回来重新探
			client.close();
		},

		setApprovalHandler(handler) {
			approvalHandler = handler;
		},

		async listModels(sessionId): Promise<EngineModelInfo[]> {
			return modelOptions(anyModels(sessionId));
		},

		async switchModel(sessionId, modelId) {
			lastError = null;
			const binding = await ensureLive(sessionId).catch((error: unknown) => {
				lastError = friendlyClaudeError(error);
				return null;
			});
			if (!binding) {
				lastError ??= "先打开一个会话";
				return false;
			}
			const target = modelIdFor(binding.models, modelId);
			if (target === null) {
				lastError = `这个模型不在 Claude Code 的可选列表里：${modelId}`;
				return false;
			}
			try {
				await client.request("session/set_model", { sessionId: binding.engineSessionId, modelId: target });
				applyModels(binding, { ...binding.models, currentModelId: target });
				return true;
			} catch (error) {
				lastError = friendlyClaudeError(error);
				return false;
			}
		},

		async currentModel(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding) {
				// 还没开会话（空状态）：用目录快照里的当前值，别让选择器与芯片显示成空的
				return currentModelOf(anyModels());
			}
			if (!binding.live && (binding.models.availableModels?.length ?? 0) === 0) {
				// 历史会话还没 resume：先用文件里最后一次用的模型，别显示成「当前默认」
				return sessionModelOf(entriesOf(sessionId));
			}
			return currentModelOf(binding.models);
		},

		async sessionModel(sessionId) {
			const persisted = sessionModelOf(entriesOf(sessionId));
			if (persisted) return persisted;
			return engine.currentModel ? engine.currentModel(sessionId) : null;
		},

		lastError: () => lastError,

		/** 历史回放：直接读 JSONL（ACP 的 load 会重放事件并占一个活句柄，不适合只读） */
		async readUiMessages(sessionId) {
			return transcriptToUiMessages(entriesOf(sessionId));
		},

		async readTranscript(sessionId): Promise<EngineMessage[]> {
			return transcriptToTranscript(entriesOf(sessionId));
		},

		/** 用量统计：四桶来自每条 assistant 的 `message.usage`；花费来自 `cost-state` */
		async sessionStats(sessionId) {
			const at = settledAt.get(sessionId);
			const settling = at !== undefined && Date.now() - at < SETTLE_MS;
			const first = transcriptStats(entriesOf(sessionId));
			if (!settling) return first;
			// 回合刚结束的一瞬间 JSONL 可能还没写完最后一条：短暂重读几次，别把半截数字写进面板
			let last = first;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 600));
				last = transcriptStats(entriesOf(sessionId));
				if (last.contextTokens !== 0 || last.assistantMessages !== first.assistantMessages) break;
			}
			return last;
		},

		/** Claude 没有删除会话的命令（`/clear` 只是开新的）：直接删掉那个 JSONL */
		async deleteSession(handle) {
			const file = claudeSessionFile(handle, { home: options.home });
			if (!deleteClaudeSession(handle, { home: options.home, sessionPath: file })) {
				throw new Error(`找不到这条会话的文件：${handle}`);
			}
		},
	};

	return engine;
}

/** 侧栏过滤的判定也对外暴露一份：会话清单与「刚建的会话在不在侧栏」要用同一套规则 */
export { isScratchCwd };
