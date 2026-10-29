/**
 * opencode 引擎适配 —— ACP 客户端实现 EnginePort。
 *
 * 映射一览（细节与实测依据见 opencode-map.ts 文件头）：
 *   建会话   → `session/new {cwd, mcpServers}`        → sessionId + configOptions（模型 / 思考档 / 模式）
 *   续接     → `session/resume {sessionId, cwd}`（ACP 要求带 cwd；不重放历史）
 *   说话     → `session/prompt`，期间收 `session/update`（正文 / 思考 / 工具 / 配置）
 *   打断     → `session/cancel`（**通知**，不是请求）
 *   换模型   → `session/set_config_option {configId:"model", value:"provider/model"}`
 *   思考档   → `session/set_config_option {configId:"effort"}`（模型不支持时该项不存在）
 *   权限     → 服务端请求 `session/request_permission` → 我们的审批弹窗
 *   不看了   → `session/close`（释放写句柄，opencode 自己的 TUI / CLI 才能接手）
 *   历史     → `opencode export <sid>`（CLI 出口，见 opencode-sessions.ts）
 *
 * 与 dsh 的三处差异（都是这一版实测出来的）：
 *   1. **工具是两段式的**：`tool_call` 只带 `title:"bash"` + `{cwd}`，真命令在下一条
 *      `tool_call_update` 里 → tool_start 要延迟，否则卡片先显示成误导性的参数；
 *   2. **思考档按 category 找**（opencode 叫 `effort`、dsh 叫 `reasoning_effort`），
 *      而且换到不支持推理的模型（deepseek-office/…）时整项消失 → 控件自动隐藏；
 *   3. **usage 有 input/output 分桶**（dsh 只有 used/size），成本统计因此以
 *      `session/prompt` 的返回为准；`usage_update` 通知不稳定，不参与记账。
 *
 * 已知边界（如实声明，界面据此隐藏控件）：
 *   - **没有子代理面板**：opencode 内部的 task 子代理不通过 ACP 暴露运行视图 → `subagents` 不实现；
 *   - **没有 steer**（回合中插队）：ACP 没有这个语义 → `streamingBehavior` 被忽略（宿主按普通一轮处理）；
 *   - **不能改会话名**：ACP 没有 rename 方法（renameSession 不实现，宿主会提示"当前引擎不支持"）；
 *   - **审批取决于 opencode 自己的权限配置**：若用户的 opencode.json 顶层写了 `permission:"allow"`，
 *     opencode 根本不会发 `session/request_permission`（实测：注入 ask 也压不过它）→ 界面上就是自动放行。
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
import { isScratchCwd } from "./scratch.js";
import { withProbeCwd } from "./catalog-probe.js";
import {
	currentModelId,
	currentThinkingLevel,
	exportStats,
	exportToTranscript,
	exportToUiMessages,
	friendlyOpencodeError,
	hasPendingUsage,
	hasUsableToolFacts,
	isFinalToolStatus,
	modelOptions,
	modelValueFor,
	parseModelValue,
	permissionApprovalRequest,
	permissionOptionId,
	stopReasonToTurnEnd,
	textEventOf,
	thinkingConfigId,
	thinkingLevels,
	toolEndEvent,
	toolStartEvent,
	usageEventOf,
	type OpencodeConfigOption,
	type OpencodeExport,
	type OpencodePermissionRequest,
	type OpencodePromptResult,
	type OpencodeUpdate,
	type ToolFacts,
} from "./opencode-map.js";
import { deleteOpencodeSession, readOpencodeExport } from "./opencode-sessions.js";
import { createOpencodeClient, type OpencodeClient } from "./opencode-transport.js";

type Binding = { engineSessionId: string; cwd: string; live: boolean; config: OpencodeConfigOption[] };
type ActiveTurn = {
	onEvent: (event: EngineEvent) => void;
	ended: boolean;
	/** 已经开过卡片的 toolCallId（opencode 的 in_progress 会重复推同一条） */
	started: Set<string>;
	/** 已经收口的 toolCallId（重复的 completed 不要再发一次 tool_end） */
	finished: Set<string>;
};

type OpencodeEngineOptions = {
	/** 共享的 ACP 客户端（会话清单也复用同一个子进程） */
	client?: OpencodeClient;
	bin?: string;
	/** 额外的 `opencode acp` 参数 */
	args?: string[];
	/** 新会话优先用的模型（`provider/model`）；不给就尊重 opencode 自己的默认 */
	model?: string | null;
	/**
	 * 删会话的实现（默认走 `opencode session delete <id>`）。
	 *
	 * 留这个口子是因为它不只被「用户删会话」用到：模型目录探针（见 catalog-probe.ts）
	 * 建完临时会话也要靠它收尾，而清理一条临时会话时不该真起一个 opencode 进程。
	 */
	deleteSession?: (engineSessionId: string) => Promise<void>;
	log?: (text: string) => void;
};

type OpencodeEngine = EnginePort & { client: OpencodeClient };

const MAX_TOOL_FACTS = 200;
/** 历史导出缓存时长：`sessionStats` 会被快照频繁调用，不能每次都起子进程 */
const EXPORT_CACHE_MS = 3000;
/**
 * 回合刚结束后多久内，「读统计」要等一下再读。
 *
 * 为什么必须有它：`session/prompt` 一返回，宿主立刻调 `sessionStats`；而 opencode
 * 是**先返回再落库**，这一瞬间 `opencode export` 还看不到最后一条 assistant
 * （实测：续聊一轮后数字停在前一轮，要等一会儿才对）。所以这一小段窗口里
 * 先让出 600ms 再读，并且不吃缓存。
 */
const EXPORT_SETTLE_MS = 3000;

export function createOpencodeEngine(options: OpencodeEngineOptions = {}): OpencodeEngine {
	const bin = options.bin ?? "opencode";
	const removeSession =
		options.deleteSession ?? ((engineSessionId: string) => deleteOpencodeSession(bin, engineSessionId));
	const client = options.client ?? createOpencodeClient({ bin, args: options.args, log: options.log ?? (() => {}) });
	const bindings = new Map<string, Binding>();
	const byEngineSession = new Map<string, string>();
	const active = new Map<string, ActiveTurn>();
	/** toolCallId → 工具事实（权限请求兜底 / 延迟开卡片用） */
	const toolFacts = new Map<string, ToolFacts>();
	const exportCache = new Map<string, { at: number; value: OpencodeExport | null }>();
	/** conversationId → 最近一次回合结束的时刻（用于 EXPORT_SETTLE_MS 的等待） */
	const settledAt = new Map<string, number>();
	let approvalHandler: ApprovalHandler | null = null;
	let lastError: string | null = null;
	/**
	 * 最近一次拿到的 configOptions（模型 / 思考档目录）。
	 * 历史会话在 resume 之前没有 config，但选择器不该是空的 —— 用它兜底；
	 * 真正切模型时仍会先 resume（拿不到就报可读错误）。
	 */
	let lastConfig: OpencodeConfigOption[] = [];
	/** 目录探针跑过没有（每个实例只探一次；`reloadModels` / `dispose` 重置） */
	let catalogProbed = false;

	const rememberTool = (facts: ToolFacts): void => {
		const previous = toolFacts.get(facts.toolCallId);
		// 后到的 update 更详细（title 从 "bash" 变成真命令），合并而不是覆盖
		toolFacts.set(facts.toolCallId, { ...previous, ...facts });
		if (toolFacts.size > MAX_TOOL_FACTS) {
			const oldest = toolFacts.keys().next().value;
			if (oldest) toolFacts.delete(oldest);
		}
	};

	const applyConfig = (binding: Binding | undefined, config: unknown): void => {
		if (!Array.isArray(config) || config.length === 0) return;
		lastConfig = config as OpencodeConfigOption[];
		if (binding) binding.config = lastConfig;
	};

	const bindingOf = (conversationId: string): Binding | null => bindings.get(conversationId) ?? null;

	const anyConfig = (conversationId?: string): OpencodeConfigOption[] => {
		const binding = conversationId ? bindingOf(conversationId) : undefined;
		if (binding && binding.config.length > 0) return binding.config;
		return [...bindings.values()].find((item) => item.config.length > 0)?.config ?? lastConfig;
	};

	/**
	 * 没有会话时把模型目录弄进来（原因与代价见 catalog-probe.ts 文件头）。
	 * opencode 的目录只在 `session/new` 的 `configOptions` 里，所以开一个临时会话抄一份，
	 * 然后 `session/close` + `opencode session delete` 收掉（不留在 CLI/TUI 的历史里）。
	 */
	const warmCatalog = async (): Promise<void> => {
		if (catalogProbed || lastConfig.length > 0) return;
		catalogProbed = true;
		await withProbeCwd(async (cwd) => {
			const created = await client.request<{ sessionId?: string; configOptions?: OpencodeConfigOption[] }>(
				"session/new",
				{ cwd, mcpServers: [] },
			);
			const engineSessionId = created?.sessionId;
			if (!engineSessionId) return;
			applyConfig(undefined, created.configOptions);
			await client.request("session/close", { sessionId: engineSessionId }).catch(() => undefined);
			await removeSession(engineSessionId).catch((error: unknown) => {
				options.log?.(
					`opencode：模型目录探针会话没删掉（${engineSessionId}）：${error instanceof Error ? error.message : String(error)}`,
				);
			});
		});
	};

	const invalidateExport = (conversationId: string): void => {
		const binding = bindingOf(conversationId);
		if (binding) exportCache.delete(binding.engineSessionId);
	};

	/** 回合结束：先失效缓存（下一次读必须重新取），并记下时刻供 sessionStats 等待 */
	const markTurnSettled = (conversationId: string): void => {
		invalidateExport(conversationId);
		settledAt.set(conversationId, Date.now());
	};

	/** 历史会话首次使用时才 resume（ACP 的 resume 会拿写句柄，所以按需） */
	const ensureLive = async (conversationId: string): Promise<Binding | null> => {
		const binding = bindingOf(conversationId);
		if (!binding) return null;
		if (binding.live) return binding;
		const result = await client.request<{ configOptions?: OpencodeConfigOption[] }>("session/resume", {
			sessionId: binding.engineSessionId,
			cwd: binding.cwd,
			mcpServers: [],
		});
		binding.live = true;
		applyConfig(binding, result?.configOptions);
		return binding;
	};

	const setOption = async (conversationId: string, configId: string, value: string): Promise<boolean> => {
		lastError = null;
		try {
			const binding = await ensureLive(conversationId);
			if (!binding) {
				lastError = "先打开一个会话";
				return false;
			}
			const result = await client.request<{ configOptions?: OpencodeConfigOption[] }>("session/set_config_option", {
				sessionId: binding.engineSessionId,
				configId,
				value,
			});
			applyConfig(binding, result?.configOptions);
			return true;
		} catch (error) {
			lastError = friendlyOpencodeError(error);
			return false;
		}
	};

	const handleToolUpdate = (conversationId: string, update: OpencodeUpdate): void => {
		const toolCallId = update.toolCallId;
		if (typeof toolCallId !== "string" || toolCallId === "") return;
		const facts: ToolFacts = { toolCallId };
		if (typeof update.title === "string") facts.title = update.title;
		if (typeof update.kind === "string") facts.kind = update.kind;
		if (update.rawInput !== undefined) facts.rawInput = update.rawInput;
		rememberTool(facts);
		const merged = toolFacts.get(toolCallId) ?? facts;

		const turn = active.get(conversationId);
		if (!turn || turn.ended) return;

		// 延迟开卡片：等「有真参数」那一条（否则先显示成 `bash {"cwd":…}`）
		if (!turn.started.has(toolCallId)) {
			const final = isFinalToolStatus(update.status);
			if (!hasUsableToolFacts(merged) && !final) return;
			turn.started.add(toolCallId);
			turn.onEvent(toolStartEvent(merged));
		}
		if (!isFinalToolStatus(update.status) || turn.finished.has(toolCallId)) return;
		turn.finished.add(toolCallId);
		turn.onEvent(toolEndEvent(update));
	};

	const handleNotification = (notification: { method: string; params: Record<string, unknown> }): void => {
		if (notification.method !== "session/update") return;
		const params = notification.params;
		const engineSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		const conversationId = byEngineSession.get(engineSessionId);
		if (!conversationId) return;
		const update = (params.update ?? {}) as OpencodeUpdate;
		if (update.sessionUpdate === "config_option_update") {
			applyConfig(bindingOf(conversationId) ?? undefined, update.configOptions);
			return;
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			handleToolUpdate(conversationId, update);
			return;
		}
		const event = textEventOf(update);
		if (!event) return;
		const turn = active.get(conversationId);
		if (turn && !turn.ended) turn.onEvent(event);
	};

	const handlePermission = async (id: number, params: OpencodePermissionRequest): Promise<void> => {
		const facts = params.toolCall?.toolCallId ? toolFacts.get(params.toolCall.toolCallId) : undefined;
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
		client.respond(id, { outcome: { outcome: "selected", optionId: permissionOptionId(params.options, decision) } });
	};

	client.onNotification(handleNotification);
	client.onServerRequest((request) => {
		if (request.method === "session/request_permission") {
			void handlePermission(request.id, request.params as OpencodePermissionRequest);
			return;
		}
		// 认不出的服务端请求必须回包，否则 opencode 那一轮会一直等
		client.respondError(request.id, -32601, `agent-web 未实现的服务端请求：${request.method}`);
	});

	/** 读一条会话的导出（带缓存）：历史回放与统计共用 */
	const exportOf = async (
		conversationId: string,
		readOptions: { fresh?: boolean } = {},
	): Promise<OpencodeExport | null> => {
		const binding = bindingOf(conversationId);
		const engineSessionId = binding?.engineSessionId ?? conversationId;
		if (!readOptions.fresh) {
			const cached = exportCache.get(engineSessionId);
			if (cached && Date.now() - cached.at < EXPORT_CACHE_MS) return cached.value;
		}
		const value = await readOpencodeExport(bin, engineSessionId, { log: options.log });
		// 读失败（opencode 忙 / 会话刚建还没落库）不写缓存，否则 3 秒内都拿不到真数据
		if (value) exportCache.set(engineSessionId, { at: Date.now(), value });
		return value;
	};

	return {
		client,
		version: () => client.version(),

		async prewarm() {
			await client.ensureStarted();
			// 顺手把模型目录也弄进来：否则切过来、还没开会话时下拉是空的（见 catalog-probe.ts）
			await warmCatalog().catch((error: unknown) => {
				options.log?.(`opencode：读取模型目录失败：${error instanceof Error ? error.message : String(error)}`);
			});
		},

		/** 重读模型表（改完 opencode 自己的配置后）：清掉快照，重新探一次 */
		async reloadModels() {
			lastConfig = [];
			catalogProbed = false;
			await warmCatalog().catch((error: unknown) => {
				options.log?.(`opencode：重读模型目录失败：${error instanceof Error ? error.message : String(error)}`);
			});
		},

		async createSession(sessionOptions: EngineSessionOptions) {
			const created = await client
				.request<{ sessionId?: string; configOptions?: OpencodeConfigOption[] }>("session/new", {
					cwd: sessionOptions.workspace,
					mcpServers: [],
				})
				.catch((error: unknown) => {
					throw new Error(friendlyOpencodeError(error));
				});
			const engineSessionId = created?.sessionId;
			if (!engineSessionId) throw new Error("opencode 没有返回 sessionId");
			const binding: Binding = {
				engineSessionId,
				cwd: sessionOptions.workspace,
				live: true,
				config: created.configOptions ?? [],
			};
			bindings.set(sessionOptions.sessionId, binding);
			byEngineSession.set(engineSessionId, sessionOptions.sessionId);
			applyConfig(binding, created.configOptions);
			exportCache.delete(engineSessionId);

			// 默认模型：只尊重显式配置（AGENT_WEB_OPENCODE_MODEL），否则用 opencode 自己的默认
			const wanted = options.model?.trim();
			if (wanted) {
				const value = modelValueFor(binding.config, wanted);
				if (value && value !== currentModelId(binding.config)) {
					await setOption(sessionOptions.sessionId, "model", value);
				} else if (!value) {
					options.log?.(`opencode：默认模型不在可选列表里，已忽略：${wanted}`);
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
				config: [],
			};
			bindings.set(openOptions.sessionId, binding);
			byEngineSession.set(engineSessionId, openOptions.sessionId);
		},

		async sendMessage(sessionId, text, onEvent, sendOptions) {
			const binding = await ensureLive(sessionId).catch((error: unknown) => {
				throw new Error(friendlyOpencodeError(error));
			});
			if (!binding) throw new Error("opencode 会话还没准备好（先新建一个会话）");

			const turn: ActiveTurn = { onEvent, ended: false, started: new Set(), finished: new Set() };
			active.set(sessionId, turn);

			const model = currentModelId(binding.config);
			if (model) onEvent({ type: "model", model });

			// ACP 的图片注入：promptCapabilities.image = true（实测声明里有）
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
				const result = await client.request<OpencodePromptResult>(
					"session/prompt",
					{ sessionId: binding.engineSessionId, prompt },
					// 一轮跑很久是正常的（有工具调用）：给 30 分钟，别用默认 30 秒掐掉
					{ timeoutMs: 30 * 60 * 1000 },
				);
				markTurnSettled(sessionId);
				const usage = usageEventOf(result);
				if (usage && !turn.ended) onEvent(usage);
				if (!turn.ended) onEvent({ type: "turn_end", reason: stopReasonToTurnEnd(result?.stopReason) });
			} catch (error) {
				invalidateExport(sessionId);
				throw new Error(friendlyOpencodeError(error));
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

		/** 不看了：关掉会话释放写句柄（opencode 自己的 TUI / CLI 才能打开它） */
		async parkSession(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding || !binding.live) return;
			binding.live = false;
			await client.request("session/close", { sessionId: binding.engineSessionId }).catch(() => undefined);
		},

		async closeSession(sessionId) {
			await this.parkSession?.(sessionId);
			const binding = bindingOf(sessionId);
			bindings.delete(sessionId);
			if (binding) {
				byEngineSession.delete(binding.engineSessionId);
				exportCache.delete(binding.engineSessionId);
			}
		},

		async dispose() {
			// 注意：**不清 lastConfig** —— 它只是「opencode 有哪些模型/档位」的目录快照，
			// 切走再切回时模型选择器不该空着；真正切模型时会先 resume 拿最新 configOptions。
			bindings.clear();
			byEngineSession.clear();
			active.clear();
			toolFacts.clear();
			exportCache.clear();
			settledAt.clear();
			catalogProbed = false; // 探针会话随进程一起没了：下次切回来重新探
			client.close();
		},

		setApprovalHandler(handler) {
			approvalHandler = handler;
		},

		async listModels(sessionId): Promise<EngineModelInfo[]> {
			return modelOptions(anyConfig(sessionId));
		},

		async switchModel(sessionId, modelId) {
			const value = modelValueFor(anyConfig(sessionId), modelId);
			if (!value) {
				lastError = `这个模型不在 opencode 的可选列表里：${modelId}`;
				return false;
			}
			return setOption(sessionId, "model", value);
		},

		async currentModel(sessionId) {
			return parseModelValue(currentModelId(anyConfig(sessionId)));
		},

		async sessionModel(sessionId) {
			return this.currentModel?.(sessionId) ?? null;
		},

		async listThinkingLevels(sessionId) {
			return thinkingLevels(anyConfig(sessionId));
		},

		async getThinkingLevel(sessionId) {
			return currentThinkingLevel(anyConfig(sessionId));
		},

		async setThinkingLevel(sessionId, level) {
			// configId 随引擎/模型而变（opencode = effort），从当前 configOptions 里取
			return setOption(sessionId, thinkingConfigId(anyConfig(sessionId)), level);
		},

		lastError: () => lastError,

		/** 历史回放：走 `opencode export`（ACP 的 load 会重放事件但会占写句柄，不适合只读） */
		async readUiMessages(sessionId) {
			return exportToUiMessages(await exportOf(sessionId));
		},

		async readTranscript(sessionId): Promise<EngineMessage[]> {
			return exportToTranscript(await exportOf(sessionId));
		},

		/** 用量统计：四桶来自每条 assistant 的 `info.tokens`（opencode 自己按次记账） */
		async sessionStats(sessionId) {
			// 回合刚结束的一小段时间：opencode 可能「消息已存、tokens 未存」→ 验证 + 重试，
			// 直到拿到已记账的那一版（理由见 EXPORT_SETTLE_MS / hasPendingUsage）
			const at = settledAt.get(sessionId);
			const settling = at !== undefined && Date.now() - at < EXPORT_SETTLE_MS;
			if (!settling) {
				const exported = await exportOf(sessionId);
				return exported ? exportStats(exported) : null;
			}
			let last: OpencodeExport | null = null;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 600));
				invalidateExport(sessionId);
				last = await exportOf(sessionId, { fresh: true });
				if (last && !hasPendingUsage(last)) return exportStats(last);
			}
			// 还没落完（或这一轮真的没有任何用量）：给最后一次的读数，不编数字
			return last ? exportStats(last) : null;
		},

		/** opencode 原生删除（`opencode session delete <sid>`）；改名没接（ACP 无此方法） */
		async deleteSession(handle) {
			await removeSession(handle);
			exportCache.delete(handle);
		},
	};
}

/** 侧栏过滤的判定也对外暴露一份：会话清单与「刚建的会话在不在侧栏」要用同一套规则 */
export { isScratchCwd };
