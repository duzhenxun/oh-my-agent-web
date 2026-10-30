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
	ModelProbeResult,
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
import { codexMultiAgentConfig, codexSubagentGuidance, createCodexSubagents } from "./codex-subagents.js";
import { registerCodexApprovals } from "./codex-approvals.js";
import { sanitizeHistoricalActions } from "../markers/actions.js";
import { suggestionGuidance } from "./suggestion-guidance.js";
import { NARRATE_GUIDANCE } from "./narrate-guidance.js";
import { ensureCodexProject } from "./codex-sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** 一次测速的中间状态（探针 thread 不属于任何会话，所以单独一张表） */
type Probe = {
	/** 发出 `turn/start` 的时刻：TTFT / 总耗时都以它为起点 */
	startedAt: number;
	/** 第一个增量（正文或思考）到达的时刻；没等到就是 null */
	firstAt: number | null;
	outputTokens: number;
	resolve: (result: ModelProbeResult) => void;
};

/**
 * 探针提示词。
 *
 * 为什么不是「回一个字」：只出 1~3 个 token 时，生成窗口只有几十毫秒，
 * 算出来的 tok/s 全是小数点后的噪声（实测 3 token / 42ms = 71 tok/s，毫无参考价值）。
 * 让它出 20 个数字：输出约 20~40 token，生成窗口有几百毫秒，速度才有意义；
 * 代价仍然只有几分钱量级。
 */
const PROBE_PROMPT = "Print the numbers 1 to 20 separated by spaces. Nothing else.";
/** 探针墙钟上限：超了就中断并报「超时」，不能让按钮一直转 */
const PROBE_TIMEOUT_MS = 60_000;
/** 低于这个输出量不报 tok/s（样本太短，算出来只是噪声） */
const MIN_TOKENS_FOR_TPS = 5;
/**
 * 生成窗口至少这么长才报「生成速度」。
 *
 * 踩过的坑：deepseek-flash 出 40 个 token 只用了 145ms（delta 是攒包过来的），
 * 算出来 276 tok/s —— 谁都知道这不可能是真的。窗口太短就只给端到端均速。
 */
const MIN_GENERATION_MS_FOR_TPS = 500;
/** 探针 thread 的 cwd：临时目录（`isScratchCwd` 判定 → 不会污染侧栏的项目列表），跑完连目录一起删 */
const PROBE_CWD_PREFIX = "agent-web-probe-";

/**
 * 一次测速的收尾算术（纯函数）。
 *
 * 出字速度按「首字节之后到收尾」这段算：把排队 / 长思考之前的等待扣除，
 * 才是模型真正的生成速度（TTFT 单独给你看）。
 */
export function probeMetrics(
	probe: { startedAt: number; firstAt: number | null; outputTokens: number },
	endedAt: number,
): ModelProbeResult {
	const totalMs = Math.max(0, endedAt - probe.startedAt);
	const ttftMs = probe.firstAt === null ? null : Math.max(0, probe.firstAt - probe.startedAt);
	const generationMs = probe.firstAt === null ? totalMs : Math.max(1, endedAt - probe.firstAt);
	const enoughTokens = probe.outputTokens >= MIN_TOKENS_FOR_TPS;
	// 生成速度：只在那段窗口够长时才算（否则攒包会把数字抬成假的几百 tok/s）
	const tps =
		enoughTokens && generationMs >= MIN_GENERATION_MS_FOR_TPS
			? Math.round((probe.outputTokens / generationMs) * 10_000) / 10
			: null;
	// 端到端均速：窗口短的时候靠它兜底（含首字延迟，不美化）
	const averageTps = enoughTokens && totalMs > 0 ? Math.round((probe.outputTokens / totalMs) * 10_000) / 10 : null;
	return { ok: true, ttftMs, totalMs, outputTokens: probe.outputTokens, tps, averageTps };
}

/**
 * 子代理策略：由宿主从 `~/.pi/agent/agents` 读出来给我们（引擎不碰磁盘上的模板文件）。
 *
 * 拿到的模板会以「`thread/start` 的按会话 config + developer instructions」的形式注入：
 * **不写**用户全局的 `~/.codex/config.toml`，所以 Codex Desktop / CLI 那边一点不受影响。
 */
export type CodexSubagentPolicy = {
	enabled: boolean;
	concurrency: number;
	profiles: { id: string; label: string; description: string }[];
};

type CodexEngineOptions = {
	/** 共享的 app-server 客户端（会话清单提供者复用同一个进程） */
	client?: CodexClient;
	bin?: string;
	home?: string;
	log?: (text: string) => void;
	/** 子代理策略（不给 = 不开：模型就没有 spawn 工具，与「如实声明能力」一致） */
	subagentPolicy?: () => CodexSubagentPolicy;
	/**
	 * 「下一步建议」要几条（设置里「想想」的那个数，1~5）：**每次建会话现读**。
	 * 不给就按默认 4~5 条教模型（见 suggestion-guidance.ts）。
	 */
	thinkCount?: () => number;
};

type CodexEngine = EnginePort & {
	/** 会话清单提供者要跟引擎共用这一个客户端 */
	client: CodexClient;
};

export function createCodexEngine(options: CodexEngineOptions = {}): CodexEngine {
	const client =
		options.client ?? createCodexClient({ bin: options.bin, home: options.home, log: options.log ?? (() => {}) });
	const bindings = new Map<string, Binding>();
	const byThread = new Map<string, string>();
	const active = new Map<string, ActiveTurn>();
	/** threadId → 探针：测速用的临时 thread 不映射到任何会话，事件走这条支线 */
	const probes = new Map<string, Probe>();
	let models: CodexModel[] | null = null;
	let approvalHandler: ApprovalHandler | null = null;
	/** 最近一次可预期失败的原因（给界面用，见 EnginePort.lastError） */
	let lastError: string | null = null;

	/**
	 * codex 的原生子代理：我们只**观测 + 停止**（委派由模型自己发起），
	 * 见 codex-subagents.ts 文件头（含实测依据）。
	 */
	const subagents = createCodexSubagents({
		request: (method, params, requestOptions) => client.request(method, params, requestOptions),
		log: (text) => options.log?.(text),
	});
	/** 现读策略：面板改了模板 / 开关，**下一条**新建的会话立刻生效（老会话保持原样） */
	const policy = (): CodexSubagentPolicy =>
		options.subagentPolicy?.() ?? { enabled: false, concurrency: subagents.concurrency(), profiles: [] };

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

	/**
	 * 把 codex 的**多代理 item** 喂给子代理观测器（面板的运行卡片就是它来的）。
	 *
	 * 只在这条 item 属于某个会话时喂：`senderThreadId` 反查宿主会话；
	 * 反查不到（比如历史 thread）就丢掉 —— 面板只显示当前会话的子代理。
	 */
	const ingestSubagent = (conversationId: string | undefined, item: CodexItem): void => {
		const type = (item as { type?: string }).type;
		if (type !== "collabAgentToolCall" && type !== "subAgentActivity") return;
		// item 自己带 senderThreadId；没有就用当前通知的 threadId 反查到的会话
		const sender = (item as { senderThreadId?: string }).senderThreadId;
		const owner = conversationId ?? (sender ? byThread.get(sender) : undefined);
		if (!owner) return;
		subagents.ingest(owner, item as never);
	};

	/**
	 * 测速支线：只做三件事 —— 记首字节时刻、记输出 token、等回合收尾。
	 * 报错一律转成一句人话（不抛，否则会把探针 Promise 挂死）。
	 */
	const handleProbeNotification = (probe: Probe, notification: CodexNotification): void => {
		const params = notification.params;
		switch (notification.method) {
			case "item/agentMessage/delta":
			case "item/reasoning/textDelta":
			case "item/reasoning/summaryTextDelta":
				if (probe.firstAt === null) probe.firstAt = Date.now();
				return;
			case "thread/tokenUsage/updated": {
				const last = (params.tokenUsage as { last?: { outputTokens?: number } } | undefined)?.last;
				if (typeof last?.outputTokens === "number") probe.outputTokens = last.outputTokens;
				return;
			}
			case "turn/completed": {
				const status = (params.turn as { status?: string } | undefined)?.status;
				if (status === "failed") {
					probe.resolve({ ok: false, message: "codex 这一轮失败了（模型不可用或额度已尽）" });
					return;
				}
				probe.resolve(probeMetrics(probe, Date.now()));
				return;
			}
			case "error": {
				// willRetry=true 是 codex 内部的瞬时重试：不要当失败
				if (params.willRetry === true) return;
				const error = params.error as { message?: string } | undefined;
				probe.resolve({ ok: false, message: friendlyCodexError(new Error(error?.message ?? "codex 报错")) });
				return;
			}
			default:
				return;
		}
	};

	const handleNotification = (notification: CodexNotification): void => {
		const params = notification.params;
		const threadId = typeof params.threadId === "string" ? params.threadId : "";
		// 测速的临时 thread 先认领：它不参与对话，事件只用来计时，绝不能串到任何会话里
		const probe = threadId ? probes.get(threadId) : undefined;
		if (probe) {
			handleProbeNotification(probe, notification);
			return;
		}
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
				const item = (params.item ?? {}) as CodexItem;
				ingestSubagent(conversationId, item);
				const event = toolStartOf(item);
				if (event) emit(event);
				return;
			}
			case "item/completed": {
				const item = (params.item ?? {}) as CodexItem;
				ingestSubagent(conversationId, item);
				const event = toolEndOf(item);
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
		subagents,
		version: () => client.version(),

		async createSession(sessionOptions: EngineSessionOptions) {
			// 对齐原生：新会话落在 codex 的 project 里（没有就建一个，幂等键按目录）
			const projectId = await ensureCodexProject(client, sessionOptions.workspace);
			/**
			 * 子代理（多代理）**按会话**开启：
			 *   - `config.agents.*` / `features.multi_agent*` 是 `thread/start` 的按 thread 覆盖，
			 *     所以模板与并发上限只对这条会话生效 —— 不写用户全局 config，Codex Desktop 不受影响；
			 *   - `developerInstructions` 里告诉模型「有哪些子代理类型、什么时候该派活」。
			 * 关掉时同样只影响这条会话：模型干脆没有 spawn 工具（而不是有个调不通的）。
			 */
			const plan = policy();
			const response = await client.request<{ thread?: { id?: string } }>("thread/start", {
				cwd: sessionOptions.workspace,
				...(projectId ? { projectId } : {}),
				config: codexMultiAgentConfig({
					enabled: plan.enabled,
					concurrency: plan.concurrency,
					profiles: plan.enabled
						? plan.profiles.map((profile) => ({
								id: profile.id,
								label: profile.label,
								description: profile.description,
							}))
						: [],
				}),
				// 「下一步建议」的写法一直带（ADR-0022，否则 codex 永远出不了建议按钮）；
				// 开了子代理就把委派说明接在后面。两者都是 **thread 级**覆盖，
				// 只对这条新会话生效 —— 不写用户的 `~/.codex/config.toml`，Codex Desktop 不受影响。
				// 「动手前先说话」放在最前面：codex 自己的提示词也会讲，但会随版本漂移，这里兜一层。
				developerInstructions: [
					NARRATE_GUIDANCE,
					suggestionGuidance(options.thinkCount?.() ?? null),
					codexSubagentGuidance({ enabled: plan.enabled, profiles: plan.profiles }),
				]
					.filter((part): part is string => part !== null)
					.join("\n\n"),
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
			subagents.dispose?.();
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

		/**
		 * 测速 = 在临时目录里开一个一次性 thread，发一句 `ping`，量首字节与出字速度。
		 *
		 * 为什么不拿 `~/.codex/auth.json` 去发 HTTP：那是偷凭证（见 port.ts 里的注释），
		 * 而且 ChatGPT 订阅额度的请求路径跟 API key 不是一回事，版本一变就坏。
		 * 这里用的全是本工具已在用的方法（thread/start → settings/update → turn/start → delete），
		 * 所以 codex 升级也不会多一个新依赖。
		 */
		async probeModel(modelId): Promise<ModelProbeResult> {
			let threadId: string | null = null;
			let cwd: string | null = null;
			let timer: ReturnType<typeof setTimeout> | null = null;
			try {
				await client.ensureStarted();
				// 模型名先对一下表：不对就直接报可读错误，不去烧一次真实回合
				const catalog = await loadModels().catch(() => [] as CodexModel[]);
				if (catalog.length > 0 && !catalog.some((model) => (model.model || model.id) === modelId)) {
					return { ok: false, message: `codex 里没有这个模型：${modelId}` };
				}
				cwd = await mkdtemp(join(tmpdir(), PROBE_CWD_PREFIX));
				const created = await client.request<{ thread?: { id?: string } }>("thread/start", { cwd });
				threadId = created?.thread?.id ?? null;
				if (!threadId) return { ok: false, message: "codex 没有返回 thread id" };
				// 用我们已经在用的那条路改模型（比猜 thread/start 的参数稳）
				await client.request("thread/settings/update", { threadId, model: modelId });

				const probeThreadId = threadId;
				const measured = new Promise<ModelProbeResult>((resolve) => {
					probes.set(probeThreadId, { startedAt: Date.now(), firstAt: null, outputTokens: 0, resolve });
				});
				const timedOut = new Promise<ModelProbeResult>((resolve) => {
					timer = setTimeout(
						() => resolve({ ok: false, message: `测速超时（${Math.round(PROBE_TIMEOUT_MS / 1000)}s 没跑完）` }),
						PROBE_TIMEOUT_MS,
					);
				});
				const turn = await client.request<{ turn?: { id?: string } }>(
					"turn/start",
					{ threadId, input: [{ type: "text", text: PROBE_PROMPT, text_elements: [] }] },
					{ timeoutMs: 30_000 },
				);
				const result = await Promise.race([measured, timedOut]);
				if (!result.ok) {
					// 超时 / 抛错：把回合收掉，别让 codex 在后台继续烧 token
					const turnId = turn?.turn?.id;
					if (turnId) await client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
				}
				return result;
			} catch (error) {
				return { ok: false, message: friendlyCodexError(error) };
			} finally {
				if (timer) clearTimeout(timer);
				if (threadId) {
					probes.delete(threadId);
					// 探针 thread 不该留在 codex 的历史里（侧栏与 Codex Desktop 都会看到它）
					await client.request("thread/delete", { threadId }).catch(() => undefined);
				}
				if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
			}
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
