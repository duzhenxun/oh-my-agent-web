/**
 * DSH（DeepSeek Harness）引擎适配 —— ACP 客户端实现 EnginePort（ADR-0037）。
 *
 * 映射一览（细节与实测依据见 dsh-map.ts 文件头）：
 *   建会话   → `session/new {cwd}`            → sessionId + configOptions（模型 / 思考档）
 *   续接     → `session/resume {sessionId, cwd}`（ACP 要求带 cwd；不重放历史）
 *   说话     → `session/prompt`，期间收 `session/update`（正文 / 思考 / 工具 / 配置）
 *   打断     → `session/cancel`
 *   换模型   → `session/set_config_option {configId:"model"}`
 *   思考档   → `session/set_config_option {configId:"reasoning_effort"}`
 *   权限     → 服务端请求 `session/request_permission` → 我们的审批弹窗
 *   不看了   → `session/close`（释放写句柄，DSH 自己的 web/tui 才能打开这条会话）
 *
 * 已知边界（step 1）：
 *   - **历史回放还没有**（ACP 不支持 `session/load`）：`readUiMessages` 返回空，
 *     历史列表也暂不提供 —— 下一步从 `~/.dsh` 的 v4 日志里读（ADR-0037 §下一步）；
 *   - token 统计暂缺（ACP 只给 `usage_update {used,size}`，没有 input/output 分桶）。
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
import { homedir } from "node:os";
import { join } from "node:path";
import { createDshClient, type DshClient } from "./dsh-transport.js";
import { locateSessionFile, readSessionHeader, readSessionLog } from "./dsh-log.js";
import { logToTranscript, logToUiMessages, statsFromLog } from "./dsh-history.js";
import { sanitizeHistoricalActions } from "../markers/actions.js";
import {
	currentModelId,
	currentThinkingLevel,
	friendlyDshError,
	modelOptions,
	modelValueFor,
	parseModelValue,
	permissionApprovalRequest,
	permissionOptionId,
	pickDefaultModelValue,
	stopReasonToTurnEnd,
	thinkingLevels,
	updateToEvent,
	type DshConfigOption,
	type DshPermissionRequest,
	type DshUpdate,
} from "./dsh-map.js";

type Binding = { sessionId: string; cwd: string; live: boolean; config: DshConfigOption[] };
type ActiveTurn = { onEvent: (event: EngineEvent) => void; ended: boolean };
type ToolFact = { title?: string; rawInput?: unknown };

export type DshEngineOptions = {
	/** 共享的 ACP 客户端（将来会话清单也复用同一个进程） */
	client?: DshClient;
	bin?: string;
	home?: string;
	/** 新会话优先用的模型路由（`provider/model`），默认挑账号路由 */
	model?: string | null;
	log?: (text: string) => void;
};

export type DshEngine = EnginePort & { client: DshClient };

const MAX_TOOL_FACTS = 200;

export function createDshEngine(options: DshEngineOptions = {}): DshEngine {
	/** DSH_HOME（会话日志与投影缓存都在它下面）；测试可覆盖 */
	const home = options.home ?? process.env.DSH_HOME?.trim() ?? join(homedir(), ".dsh");
	const sessionsRoot = join(home, "sessions");
	const client =
		options.client ?? createDshClient({ bin: options.bin, home: options.home, log: options.log ?? (() => {}) });
	const bindings = new Map<string, Binding>();
	const bySession = new Map<string, string>();
	const active = new Map<string, ActiveTurn>();
	/** toolCallId → 工具事实（权限请求只带 id，名字/参数得从这里补） */
	const toolFacts = new Map<string, ToolFact>();
	let approvalHandler: ApprovalHandler | null = null;
	let lastError: string | null = null;
	/**
	 * 最近一次拿到的 configOptions（模型/思考档目录）。
	 * 历史会话在 resume 之前没有 config，但选择器不该是空的 —— 用它兜底；
	 * 真正切模型时仍会先 resume（拿不到就报可读错误）。
	 */
	let lastConfig: DshConfigOption[] = [];

	const rememberTool = (id: string, update: DshUpdate): void => {
		toolFacts.set(id, { title: update.title, rawInput: update.rawInput });
		if (toolFacts.size > MAX_TOOL_FACTS) {
			const oldest = toolFacts.keys().next().value;
			if (oldest) toolFacts.delete(oldest);
		}
	};

	const applyConfig = (binding: Binding | undefined, config: unknown): void => {
		if (!Array.isArray(config) || config.length === 0) return;
		lastConfig = config as DshConfigOption[];
		if (binding) binding.config = lastConfig;
	};

	const bindingOf = (conversationId: string): Binding | null => bindings.get(conversationId) ?? null;

	/** 会话 id → 日志文件；cwd 未知时按 id 扫一层（历史会话第一次打开就是这条路径） */
	const logFileOf = (binding: Binding | null, sessionId: string): string | null => {
		const id = binding?.sessionId ?? sessionId;
		const file = locateSessionFile(sessionsRoot, id, binding?.cwd || undefined);
		if (!file) return null;
		// 顺手把 cwd 补上：`session/resume` 必须带 cwd，而历史会话的 cwd 只在 header 里
		if (binding && binding.cwd === "") {
			const header = readSessionHeader(file);
			if (typeof header?.cwd === "string") binding.cwd = header.cwd;
		}
		return file;
	};
	const anyConfig = (conversationId?: string): DshConfigOption[] => {
		const binding = conversationId ? bindingOf(conversationId) : undefined;
		if (binding && binding.config.length > 0) return binding.config;
		return [...bindings.values()].find((item) => item.config.length > 0)?.config ?? lastConfig;
	};

	/** 历史会话首次使用时才 resume（ACP 的 resume 会拿到写句柄，所以按需） */
	const ensureLive = async (conversationId: string): Promise<Binding | null> => {
		const binding = bindingOf(conversationId);
		if (!binding) return null;
		if (binding.live) return binding;
		const result = await client.request<{ configOptions?: DshConfigOption[] }>("session/resume", {
			sessionId: binding.sessionId,
			cwd: binding.cwd,
			mcpServers: [],
		});
		binding.live = true;
		applyConfig(binding, result?.configOptions);
		return binding;
	};

	const setOption = async (
		conversationId: string,
		configId: "model" | "reasoning_effort",
		value: string,
	): Promise<boolean> => {
		lastError = null;
		try {
			const binding = await ensureLive(conversationId);
			if (!binding) {
				lastError = "先打开一个会话";
				return false;
			}
			const result = await client.request<{ configOptions?: DshConfigOption[] }>("session/set_config_option", {
				sessionId: binding.sessionId,
				configId,
				value,
			});
			applyConfig(binding, result?.configOptions);
			return true;
		} catch (error) {
			lastError = friendlyDshError(error);
			return false;
		}
	};

	const handleNotification = (notification: { method: string; params: Record<string, unknown> }): void => {
		if (notification.method !== "session/update") return;
		const params = notification.params;
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		const conversationId = bySession.get(sessionId);
		if (!conversationId) return;
		const update = (params.update ?? {}) as DshUpdate;
		if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
			rememberTool(update.toolCallId, update);
		}
		if (update.sessionUpdate === "config_option_update") {
			applyConfig(bindingOf(conversationId) ?? undefined, (update as { configOptions?: unknown }).configOptions);
		}
		const event = updateToEvent(update);
		const turn = active.get(conversationId);
		if (event && turn && !turn.ended) turn.onEvent(event);
	};

	const handlePermission = async (id: number, params: DshPermissionRequest): Promise<void> => {
		const facts = params.toolCall?.toolCallId ? toolFacts.get(params.toolCall.toolCallId) : undefined;
		const request = permissionApprovalRequest(params, facts);
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
			void handlePermission(request.id, request.params as DshPermissionRequest);
			return;
		}
		// 认不出的服务端请求必须回包，否则 DSH 那一轮会一直等
		client.respondError(request.id, -32601, `agent-web 未实现的服务端请求：${request.method}`);
	});

	return {
		client,
		version: () => client.version(),

		async prewarm() {
			await client.ensureStarted();
		},

		async createSession(sessionOptions: EngineSessionOptions) {
			const created = await client.request<{ sessionId?: string; configOptions?: DshConfigOption[] }>(
				"session/new",
				{ cwd: sessionOptions.workspace, mcpServers: [] },
			);
			const sessionId = created?.sessionId;
			if (!sessionId) throw new Error("dsh 没有返回 sessionId");
			const binding: Binding = {
				sessionId,
				cwd: sessionOptions.workspace,
				live: true,
				config: created.configOptions ?? [],
			};
			bindings.set(sessionOptions.sessionId, binding);
			bySession.set(sessionId, sessionOptions.sessionId);

			// 默认模型：优先「账号路由」，否则第一次 prompt 会报 no API key（见 pickDefaultModelValue）
			const wanted = pickDefaultModelValue(binding.config, options.model);
			const current = currentModelId(binding.config);
			if (wanted && parseModelValue(wanted)) {
				const wantedId = modelOptions(binding.config).find((model) => modelValueFor(binding.config, model.id) === wanted);
				if (!current || (wantedId && wantedId.id !== current)) {
					await setOption(sessionOptions.sessionId, "model", wanted);
				}
			}
			return { sessionPath: null, engineSessionId: sessionId };
		},

		async openSession(openOptions: EngineOpenOptions) {
			const sessionId = openOptions.engineSessionId ?? openOptions.sessionPath ?? openOptions.sessionId;
			const binding: Binding = { sessionId, cwd: openOptions.cwd ?? "", live: false, config: [] };
			bindings.set(openOptions.sessionId, binding);
			bySession.set(sessionId, openOptions.sessionId);
		},

		async sendMessage(sessionId, text, onEvent) {
			const binding = await ensureLive(sessionId).catch((error: unknown) => {
				throw new Error(friendlyDshError(error));
			});
			if (!binding) throw new Error("DSH 会话还没准备好（先新建一个会话）");

			const turn: ActiveTurn = { onEvent, ended: false };
			active.set(sessionId, turn);
			try {
				const result = await client.request<{ stopReason?: string }>(
					"session/prompt",
					{ sessionId: binding.sessionId, prompt: [{ type: "text", text }] },
					// 一轮跑很久是正常的（有工具调用）：给 30 分钟，别用默认 30 秒掐掉
					{ timeoutMs: 30 * 60 * 1000 },
				);
				if (!turn.ended) onEvent({ type: "turn_end", reason: stopReasonToTurnEnd(result?.stopReason) });
			} finally {
				turn.ended = true;
				active.delete(sessionId);
			}
		},

		async interrupt(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding) return;
			// ACP 里 cancel 是**通知**（无 id）：发成请求会被当成未知方法丢掉 → 停止按钮没反应
			client.notify("session/cancel", { sessionId: binding.sessionId });
		},

		/** 不看了：关掉会话释放写句柄（DSH 自己的 web/tui 才能打开它） */
		async parkSession(sessionId) {
			const binding = bindingOf(sessionId);
			if (!binding || !binding.live) return;
			binding.live = false;
			await client.request("session/close", { sessionId: binding.sessionId }).catch(() => undefined);
		},

		async closeSession(sessionId) {
			await this.parkSession?.(sessionId);
			const binding = bindingOf(sessionId);
			bindings.delete(sessionId);
			if (binding) bySession.delete(binding.sessionId);
		},

		async dispose() {
			lastConfig = [];
			bindings.clear();
			bySession.clear();
			active.clear();
			toolFacts.clear();
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
				lastError = `这个模型不在 DSH 的可选列表里：${modelId}`;
				return false;
			}
			return setOption(sessionId, "model", value);
		},

		async currentModel(sessionId) {
			const parsed = parseModelValue(
				anyConfig(sessionId).find((option) => option.id === "model")?.currentValue,
			);
			return parsed;
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
			return setOption(sessionId, "reasoning_effort", level);
		},

		lastError: () => lastError,

		/**
		 * 历史回放：ACP 不支持 `session/load`，所以读 DSH 自己的 v4 日志
		 * （多帧 zstd → 事件流 → 消息块；规则见 dsh-history.ts）。
		 */
		async readUiMessages(sessionId) {
			const file = logFileOf(bindingOf(sessionId), sessionId);
			if (!file) return [];
			return sanitizeHistoricalActions(logToUiMessages(readSessionLog(file)));
		},

		async readTranscript(sessionId): Promise<EngineMessage[]> {
			const file = logFileOf(bindingOf(sessionId), sessionId);
			if (!file) return [];
			return logToTranscript(readSessionLog(file));
		},

		/** 用量统计：四桶来自 `assistant/message.data.usage`，不依赖 ACP 的 usage_update */
		async sessionStats(sessionId) {
			const file = logFileOf(bindingOf(sessionId), sessionId);
			if (!file) return null;
			return statsFromLog(readSessionLog(file));
		},
	};
}
