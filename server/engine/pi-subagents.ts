/**
 * 子代理运行时（引擎侧，唯一允许碰 SDK 的地方）。
 *
 * 一次子代理 = **一个真实的 pi 会话**（自己的 session 文件、自己的工具白名单、自己的上下文）：
 *   - 会话文件紧挨着父会话归档：`<父会话目录>/<父会话名>/subagents/<runId>.jsonl`，
 *     既不污染侧栏的项目清单（那里只读一层 *.jsonl），事后又能被 pi 找到；
 *   - 工具白名单来自模板（`read, grep, ...`）：Explore/Plan 只拿到只读工具；
 *   - 上下文隔离：子会话只看到任务原文，看不到父会话的历史（也就不会把父上下文读脏）。
 *
 * 并发：`setConcurrency(n)` 决定同时几个在跑，超出的排队（面板显示「排队中」）。
 * 状态变化通过 `subscribe` 推给宿主，宿主再投影进快照 —— 引擎不认识任何 UI 类型。
 */
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { DefaultResourceLoader, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { mapSessionEvent } from "./pi-events.js";
import type { SubagentEnginePort, SubagentRequest } from "./port.js";
import type { SubagentRunView } from "../protocol.js";

type AnyRecord = Record<string, unknown>;

const asRecord = (value: unknown): AnyRecord =>
	typeof value === "object" && value !== null ? (value as AnyRecord) : {};

/** 面板上能看的结果正文上限（子代理动辄几千字，快照不能跟着涨） */
const RESULT_CHARS = 4000;
/** 存活记录上限：跑满一天的会话不该在内存里无限堆（面板只显示当前会话的，旧的其实是历史） */
const MAX_RUNS = 60;
/** 状态推进的节流：正文增量很频繁，面板只需要「大概每秒一次」的刷新 */
const EMIT_INTERVAL_MS = 300;
/**
 * 单个子代理的**墙钟**上限。
 *
 * `session.prompt()` 没有任何超时参数，模板里的 `maxTurns` 也只在 `message_end` 时才检查 ——
 * 一个卡在长工具调用 / provider 静默断流（不报错也不结束）的子会话可以永远挂着：
 * 它占着一个并发槽（超了上限就再也不会起新的）、持续烧 token，
 * 而且宿主侧只能靠用户手动点「停止」。
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

type RunState = {
	view: SubagentRunView;
	controller: AbortController;
	session: { prompt: (text: string) => Promise<void>; abort: () => Promise<void>; dispose: () => void } | null;
	/** 已结算（完成 / 失败 / 中止），迟到的事件不再改状态 */
	settled: boolean;
	assistantTurns: number;
};

type PiSubagentsOptions = {
	agentDir: string;
	/** 引擎自己的会话根（默认交给 SDK 决定） */
	sessionDir?: string;
	/** 初始并发上限（宿主读到设置后会再同步一次） */
	concurrency?: number;
	/** 单个子代理的墙钟上限（默认 20 分钟；测试可调小） */
	timeoutMs?: number;
	/**
	 * 取父会话（AgentSession）。子会话**沿用父会话的模型运行时与模型**：
	 *   - 模型运行时里带着父会话已经注册好的 provider（有的 provider 只有扩展里才有，
	 *     子会话 `noExtensions` 时自己解析不到 → 直接报「没有注册这个 api」）；
	 *   - 模型跟随主对话当前的选择，用户换模型不用再去改每个模板。
	 * 引擎内部通道（不是 port 的一部分）：port 只描述「起/停/订阅」，不往外漏 SDK 对象。
	 */
	getParentSession?: (conversationId: string) => unknown | null;
	onNotice?: (text: string, level?: "info" | "warn" | "error") => void;
	now?: () => number;
};

/**
 * 子会话不加载扩展（noExtensions）：由扩展注册的 provider（api 是扩展自己的实现）
 * 在子会话里就找不到 —— SDK 只会甩一句英文「No API provider registered for api: xxx」。
 * 这里补一句人话，否则用户看到一屏英文完全不知道下一步该干嘛。
 */
function explainError(message: string): string {
	if (/No API provider registered for api:/i.test(message)) {
		return `${message}\n（子代理会话不加载扩展：这个模型是由扩展提供的。换一个内置 provider 的模型，或在子代理模板里指定模型。）`;
	}
	return message;
}

/** 给定父会话文件，算出子代理的会话目录（与父会话并列，不进项目清单） */
function subagentSessionDir(parentSessionPath: string | null, fallbackDir?: string): string | undefined {
	if (!parentSessionPath) return fallbackDir;
	return join(dirname(parentSessionPath), basename(parentSessionPath, ".jsonl"), "subagents");
}

export function createPiSubagents(options: PiSubagentsOptions): SubagentEnginePort {
	const now = options.now ?? (() => Date.now());
	const runs = new Map<string, RunState>();
	const order: string[] = [];
	const queue: string[] = [];
	const listeners = new Set<(run: SubagentRunView) => void>();
	let limit = Math.max(1, options.concurrency ?? 4);
	let active = 0;
	const lastEmit = new Map<string, number>();

	function emit(run: SubagentRunView): void {
		for (const listener of listeners) {
			try {
				listener({ ...run, tokens: run.tokens ? { ...run.tokens } : undefined });
			} catch {
				// 宿主侧抛错不能打断子代理
			}
		}
	}

	/** 节流推：状态跃迁（开始/结束/失败）永远立刻推，正文增量按 300ms 拢一次 */
	function publish(state: RunState, immediate = false): void {
		const at = now();
		const last = lastEmit.get(state.view.id) ?? 0;
		if (!immediate && at - last < EMIT_INTERVAL_MS) return;
		lastEmit.set(state.view.id, at);
		emit(state.view);
	}

	function settle(state: RunState, patch: Partial<SubagentRunView>): void {
		if (state.settled) return;
		state.settled = true;
		state.view = { ...state.view, ...patch, endedAt: patch.endedAt ?? now() };
		publish(state, true);
	}

	function trim(): void {
		while (order.length > MAX_RUNS) {
			const oldest = order.shift();
			if (!oldest) break;
			const state = runs.get(oldest);
			if (state && state.view.status === "running") {
				order.push(oldest);
				break;
			}
			runs.delete(oldest);
			lastEmit.delete(oldest);
		}
	}

	/** 模板里的模型引用：`provider/model`，取不到就算了（不让切换失败把这次委派打死） */
	async function applyModel(session: AnyRecord, reference: string | undefined): Promise<string | undefined> {
		const wanted = reference?.trim();
		if (!wanted) return undefined;
		const runtime = session.modelRuntime as { getAvailable?: () => Promise<unknown[]> } | undefined;
		if (!runtime?.getAvailable) return undefined;
		const [provider, ...rest] = wanted.split("/");
		const modelId = rest.join("/");
		try {
			const available = (await runtime.getAvailable()) as Array<{ provider?: string; id?: string }>;
			const match = available.find(
				(item) => String(item.provider) === provider && (modelId === "" || String(item.id) === modelId),
			);
			if (!match) {
				options.onNotice?.(`子代理模板里的模型 ${wanted} 不可用，改用默认模型`, "warn");
				return undefined;
			}
			await (session as unknown as { setModel: (model: unknown) => Promise<void> }).setModel(match);
			return modelId === "" ? String((match as { id?: string }).id ?? "") : modelId;
		} catch {
			return undefined;
		}
	}

	/**
	 * 一次尝试：建子会话 → 喂任务 → 等它停。返回失败原因（成功为 null），不落状态。
	 *
	 * `withExtensions`：子代理默认不加载扩展（快、可控）。但有的 provider 是扩展注册的，
	 * 那种模型在「无扩展」的子会话里会报 `No API provider registered for api:` ——
	 * 这时由 execute 用 `withExtensions` 再试一次（失败发生在花 token 之前，代价很小）。
	 */
	async function attempt(state: RunState, request: SubagentRequest, withExtensions: boolean): Promise<string | null> {
		const view = state.view;
		const childDir = subagentSessionDir(request.parentSessionPath, options.sessionDir);
		const sessionManager = SessionManager.create(request.workspace, childDir, {
			id: `${view.id.replace(/^sub-/, "")}${withExtensions ? "-x" : ""}`,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.workspace,
			agentDir: options.agentDir,
			// 子代理是「干活的手」，不是另一个助手：技能 / 提示模板 / 主题 / 上下文文件都不加载
			noExtensions: !withExtensions,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			appendSystemPrompt: [request.profile.systemPrompt],
		});
		await resourceLoader.reload();
		const thinking = request.profile.thinking as never;
		const parent = asRecord(options.getParentSession?.(request.conversationId) ?? null);
		const parentRuntime = parent.modelRuntime as never;
		const parentModel = parent.model as never;
		const { session } = await createAgentSession({
			cwd: request.workspace,
			agentDir: options.agentDir,
			resourceLoader,
			sessionManager,
			tools: request.profile.tools,
			// 沿用父会话的模型运行时（provider 注册在它上面）与当前模型
			...(parentRuntime ? { modelRuntime: parentRuntime } : {}),
			...(parentModel && !request.profile.model ? { model: parentModel } : {}),
			...(thinking ? { thinkingLevel: thinking } : {}),
		});
		state.session = session as unknown as RunState["session"];
		view.sessionPath = sessionManager.getSessionFile() ?? undefined;
		const resolvedModel = await applyModel(session as unknown as AnyRecord, request.profile.model);
		if (resolvedModel) view.model = resolvedModel;
		else {
			const model = (session as unknown as { model?: { provider?: string; id?: string } }).model;
			if (model) view.model = `${String(model.provider ?? "?")}/${String(model.id ?? "?")}`;
		}
		publish(state, true);
		if (state.controller.signal.aborted) return "已停止";

		let text = "";
		let errorText: string | null = null;
		let settled: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			settled = resolve;
		});
		const off = session.subscribe((event: unknown) => {
			const mapped = mapSessionEvent(event);
			const record = asRecord(event);
			if (mapped) {
				if (mapped.type === "text_delta") {
					text += mapped.text;
					view.result = text.length > RESULT_CHARS ? text.slice(-RESULT_CHARS) : text;
					publish(state);
					return;
				}
				if (mapped.type === "tool_start") {
					view.toolCalls = (view.toolCalls ?? 0) + 1;
					publish(state);
					return;
				}
				if (mapped.type === "usage" && mapped.final) {
					const current = view.tokens ?? { input: 0, output: 0, total: 0 };
					view.tokens = {
						input: current.input + mapped.input,
						output: current.output + mapped.output,
						total: current.total + mapped.input + mapped.output + mapped.cacheRead + mapped.cacheWrite,
					};
					if (mapped.cost) view.cost = (view.cost ?? 0) + mapped.cost;
					publish(state);
					return;
				}
				if (mapped.type === "model") {
					view.model = mapped.model;
					return;
				}
				if (mapped.type === "error") {
					errorText = mapped.message;
					return;
				}
				return;
			}
			if (record.type === "message_end") {
				const message = asRecord(record.message);
				if (message.role === "assistant") {
					state.assistantTurns += 1;
					const limitTurns = request.profile.maxTurns;
					if (limitTurns && state.assistantTurns > limitTurns) {
						errorText = `超过模板允许的最大轮次（${limitTurns}）`;
						void session.abort().catch(() => undefined);
					}
				}
				return;
			}
			if (record.type === "agent_settled") settled();
		});
		try {
			/**
			 * 墙钟超时：`prompt()` 没有超时参数，卡住的子会话会一直占并发槽 + 烧 token。
			 * 到点先 abort（尽量让它正常收尾），并且**不再等 prompt 的 Promise** ——
			 * 真正卡死的会话那个 Promise 是永远不会 resolve 的。
			 */
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
			let timer: ReturnType<typeof setTimeout> | null = null;
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					errorText = errorText ?? `子代理超时（超过 ${minutes} 分钟没有结束）`;
					void session.abort().catch(() => undefined);
					resolve();
				}, timeoutMs);
				timer.unref?.();
			});
			let promptError: unknown = null;
			const prompt = session.prompt(request.task).catch((error: unknown) => {
				promptError = error;
			});
			try {
				await Promise.race([prompt, deadline]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (promptError !== null) throw promptError instanceof Error ? promptError : new Error(String(promptError));
			// prompt() 返回后仍可能有收尾事件：给它 50ms（与宿主侧同一套做法）
			await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 50))]);
		} finally {
			off();
			try {
				session.dispose();
			} catch {
				// 已经关掉了
			}
			state.session = null;
		}
		if (state.controller.signal.aborted) return "已停止";
		return errorText;
	}

	async function execute(state: RunState, request: SubagentRequest): Promise<void> {
		const view = state.view;
		view.status = "running";
		view.startedAt = now();
		publish(state, true);
		try {
			let error = await attempt(state, request, false);
			// 扩展注册的 provider 在「无扩展」子会话里找不到：装上扩展再试一次
			if (error !== null && /No API provider registered for api:/i.test(error)) {
				view.tokens = undefined;
				view.toolCalls = undefined;
				view.result = undefined;
				state.assistantTurns = 0;
				error = await attempt(state, request, true);
			}
			if (state.controller.signal.aborted) {
				settle(state, { status: "aborted", error: "已停止", result: view.result });
			} else if (error !== null) {
				settle(state, { status: "failed", error: explainError(error), result: view.result });
			} else {
				settle(state, { status: "completed", result: view.result });
			}
		} catch (caught) {
			settle(state, {
				status: "failed",
				error: caught instanceof Error ? caught.message : String(caught),
			});
		} finally {
			try {
				state.session?.dispose();
			} catch {
				// 已经关掉了
			}
			state.session = null;
			active -= 1;
			pump();
		}
	}

	function pump(): void {
		while (active < limit && queue.length > 0) {
			const id = queue.shift();
			if (!id) return;
			const state = runs.get(id);
			if (!state || state.settled) continue;
			const request = (state as RunState & { request?: SubagentRequest }).request;
			if (!request) continue;
			active += 1;
			void execute(state, request);
		}
	}

	/** 停掉一个在跑 / 在排队的子代理（留一个本地函数：对象方法不能依赖 `this`，宿主拿到的可能是代理） */
	async function interrupt(id: string): Promise<void> {
		const state = runs.get(id);
		if (!state) return;
		const at = queue.indexOf(id);
		if (at >= 0) queue.splice(at, 1);
		state.controller.abort();
		if (state.view.status === "queued" || !state.session) {
			settle(state, { status: "aborted", error: "已停止" });
			pump();
			return;
		}
		try {
			await state.session.abort();
		} catch {
			// 已经停了
		}
	}

	return {
		async start(request) {
			const id = `sub-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
			const view: SubagentRunView = {
				id,
				conversationId: request.conversationId,
				profile: request.profile.id,
				label: request.profile.label,
				description: request.description,
				status: "queued",
				task: request.task,
				startedAt: now(),
			};
			const state: RunState = {
				view,
				controller: new AbortController(),
				session: null,
				settled: false,
				assistantTurns: 0,
			};
			(state as RunState & { request?: SubagentRequest }).request = request;
			runs.set(id, state);
			order.push(id);
			queue.push(id);
			trim();
			emit(view);
			pump();
			return { id };
		},

		interrupt,

		get(id) {
			const state = runs.get(id);
			return state ? { ...state.view, tokens: state.view.tokens ? { ...state.view.tokens } : undefined } : null;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		setConcurrency(next) {
			limit = Math.min(12, Math.max(1, Math.round(next)));
			pump();
		},

		async dispose() {
			for (const id of runs.keys()) {
				await interrupt(id).catch(() => undefined);
			}
			listeners.clear();
		},
	};
}
