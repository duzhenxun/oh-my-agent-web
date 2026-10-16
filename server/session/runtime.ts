/**
 * 会话运行时（宿主侧）：把引擎事件翻译成 UI 状态 / 协议事件，并把转录落盘（M2）。
 *
 * 遵守的规则（都已由 ADR 定死）：
 *   - 全局同时只允许 **1 路在飞回合**（ADR-0005）：再发就拒绝 + 提示，不排队；
 *   - 切换会话**不中断**在跑的回合（ADR-0005）：引擎在服务端继续干活，切回来靠快照看结果；
 *   - 危险操作走审批三态（ADR-0006）：允许一次 / 总是允许这类 / 拒绝；
 *   - 快照只在**结构性变化**时推：正文靠 message_delta 增量（ADR-0004 §3）；
 *   - 转录**追加写**：用户消息发出时落盘；助手消息**在回合结束时**落盘（整条，不留半条）。
 *     代价写清楚：进程在回合计中被杀 → 这一轮的助手输出丢失（用户消息还在）。
 */
import type { RuleStore } from "../approval/rules.js";
import { createApprovalBridge } from "./approval-bridge.js";
import { createEngineBinding } from "./engine-binding.js";
import {
	loadConversationMessages,
	persistIndexSafely,
	renameConversation,
	updateConversationMeta,
} from "./conversation-meta.js";
import { createNoticeSink } from "./notices.js";
import { applyEngineEvent, type TurnEventContext } from "./turn-events.js";
import { makeIdFactory } from "../util/ids.js";
import type { ApprovalDecision, Notice, PiProject, ProtocolError, ServerEvent, Snapshot } from "../protocol.js";
import type { EnginePort } from "../engine/port.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import {
	buildSnapshot,
	createConversation,
	createServerState,
	emptyRunning,
	type ServerState,
} from "../snapshot/state.js";
import { deriveTitle, type ConversationStore } from "./store.js";

export type RuntimeEmit = {
	snapshot(snapshot: Snapshot): void;
	event(event: ServerEvent): void;
};

export type Result = { ok: true } | { ok: false; error: ProtocolError };

export type Runtime = {
	init(): Promise<void>;
	snapshot(): Snapshot;
	state(): ServerState;
	sendMessage(text: string): Promise<Result>;
	interrupt(): Promise<Result>;
	approve(requestId: string, decision: ApprovalDecision): Result;
	newConversation(): Promise<Result>;
	switchConversation(conversationId: string): Promise<Result>;
	/** 重新扫 pi 已有的项目/会话（ADR-0021 §1）；带最小间隔，避免每次刷新都扫盘 */
	refreshPiSessions(force?: boolean): Promise<void>;
	/** 给宿主其他部分（引擎、启动流程）推一条界面提示 */
	notify(text: string, level?: Notice["level"]): void;
	isBusy(): boolean;
};

export type RuntimeOptions = {
	engine: EnginePort;
	store: ConversationStore;
	/** 审批规则落盘（ADR-0006）：「总是允许这类」跨重启生效 */
	rules: RuleStore;
	/** pi 已有会话的扫描器（ADR-0021 §1）；不给就不显示那一栏（单测用） */
	piSessions?: () => Promise<PiProject[]>;
	/** 两次扫描的最小间隔（默认 10s） */
	piSessionsMinIntervalMs?: number;
	workspace: string;
	/** 当前引擎名（ADR-0016）：会进快照，供界面决定提示语 */
	engineName?: "pi" | "fake";
	emit: RuntimeEmit;
	now?: () => number;
	/** 测试注入可预测的 id；默认 `<前缀>-<序号>` */
	idSeq?: (prefix: string) => string;
	noticeDedupeMs?: number;
	maxNotices?: number;
	titleChars?: number;
};

export function createRuntime(options: RuntimeOptions): Runtime {
	const now = options.now ?? (() => Date.now());
	const piScanIntervalMs = options.piSessionsMinIntervalMs ?? 10_000;
	let lastPiScanAt = Number.NEGATIVE_INFINITY;
	const noticeDedupeMs = options.noticeDedupeMs ?? 5000;
	const maxNotices = options.maxNotices ?? 20;
	const titleChars = options.titleChars ?? 24;

	const state = createServerState(options.workspace, options.engineName ?? "pi");
	// 工作区根是已知事实（ADR-0012 的 files 元数据；文件树内容在 M4）
	state.files = { root: options.workspace, treeVersion: 0 };

	/** 哪些会话的消息已经从磁盘读进内存 */
	const loadedConversations = new Set<string>();

	// 默认真实运行用全局唯一 id（ADR-0019）；测试注入确定性 id
	const nextId = options.idSeq ?? makeIdFactory();
	let inFlight = false;
	let currentTurn: { conversationId: string; messageId: string } | null = null;
	/** 回合结束时的落盘任务：sendMessage 必须在返回前等它完成（否则「应答已回、转录还没写」） */
	let finishPromise: Promise<void> | null = null;

	const pushSnapshot = () => options.emit.snapshot(buildSnapshot(state));

	/** 重新扫 pi 已有的项目/会话（ADR-0021 §1）：带最小间隔，避免每次刷新都扫 247 个文件 */
	async function refreshPiSessions(force = false): Promise<void> {
		if (!options.piSessions) return;
		const stamp = now();
		if (!force && stamp - lastPiScanAt < piScanIntervalMs) return;
		lastPiScanAt = stamp;
		try {
			state.piProjects = await options.piSessions();
			pushSnapshot();
		} catch (error) {
			// 扫不到（pi 没装 / 目录被删）不该影响主流程，只在界面上给一条提示
			notice(`读取 pi 已有会话失败：${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	}

	const noticeSink = createNoticeSink({
		now,
		nextId,
		dedupeMs: noticeDedupeMs,
		max: maxNotices,
		onNotice: (entry) => {
			// 快照的来源仍是 state（ADR-0012：快照是前端唯一事实源）
			state.notices = [...state.notices, entry].slice(-maxNotices);
			options.emit.event({ type: "event", event: "notice", notice: entry });
			pushSnapshot();
		},
	});
	const notice = (text: string, level: Notice["level"] = "info"): void => {
		noticeSink.push(text, level);
	};

	// 审批桥（ADR-0006）：规则命中直接放行，否则等界面点一下（拆到单独模块，见 approval-bridge.ts）
	const approval = createApprovalBridge({
		rules: options.rules,
		now,
		nextId,
		onPending: (nextPending) => {
			state.pendingApproval = nextPending;
			state.running.status = nextPending ? "awaiting_approval" : "streaming";
			pushSnapshot();
		},
		onNotice: (text, level) => notice(text, level),
	});
	options.engine.setApprovalHandler(approval.handler);

	// 引擎会话的生命周期（懒创建 + 历史注入 + 读模型），见 ADR-0018
	const binding = createEngineBinding({
		engine: options.engine,
		workspace: state.workspace,
		messagesOf: (conversationId) => state.messages[conversationId] ?? [],
		onModel: (model) => {
			state.model = model.provider + "/" + model.model;
			pushSnapshot();
		},
	});

	async function createConversationInternal(title: string): Promise<string> {
		const id = nextId("conv");
		const ts = now();
		const meta = createConversation({ id, title, workspace: state.workspace, now: ts });
		state.conversations = [...state.conversations, meta];
		state.messages[id] = [];
		loadedConversations.add(id);
		state.activeId = id;
		try {
			await options.store.create({ id, title, workspace: state.workspace, now: ts });
			await binding.ensure(id);
		} catch (error) {
			// 回滚：不留「半存在的会话」
			state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
			delete state.messages[id];
			loadedConversations.delete(id);
			binding.forget(id);
			state.activeId = null;
			throw error;
		}
		await persistIndexSafely(options.store, state.conversations, (message) => notice(message, "warn"));
		pushSnapshot();
		return id;
	}

	/** 没有活动会话时按首条输入建一个（会落盘，见 ADR-0015） */
	async function ensureConversation(seedText: string): Promise<string> {
		if (state.activeId) return state.activeId;
		return createConversationInternal(deriveTitle(seedText, titleChars));
	}

	const turnContext: TurnEventContext = {
		state,
		now,
		emitEvent: (event) => options.emit.event(event),
		pushSnapshot,
		notice,
		onTurnEnd: (conversationId, reason) => {
			finishPromise = finishTurn(conversationId, reason);
		},
	};

	async function finishTurn(conversationId: string, reason: "done" | "interrupted" | "error"): Promise<void> {
		const keepError = reason === "error" || state.running.status === "error";
		state.running = { ...emptyRunning(), status: keepError ? "error" : "idle" };
		state.pendingApproval = null;
		approval.cancelPending();

		// 助手消息在回合结束落盘：整条写入，不留半条（代价：进程在回合计中被杀会丢这一轮的助手输出）
		const turn = currentTurn;
		currentTurn = null;
		if (turn && turn.conversationId === conversationId) {
			const message = (state.messages[conversationId] ?? []).find((item) => item.id === turn.messageId);
			if (message) {
				try {
					await options.store.appendMessage(conversationId, message);
				} catch (error) {
					notice(`转录写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		}

		updateConversationMeta(state, conversationId, now());
		await persistIndexSafely(options.store, state.conversations, (message) => notice(message, "warn"));
		if (reason === "interrupted") notice("回合已中断", "info");
		pushSnapshot();
	}

	return {
		async init() {
			const { conversations, rebuilt } = await options.store.init();
			state.conversations = conversations;
			for (const meta of conversations) state.messages[meta.id] = [];
			const ruleCount = await approval.loadRules();
			if (rebuilt && conversations.length > 0) {
				notice(`会话索引已从转录重建（${conversations.length} 个会话）`, "info");
			}
			if (ruleCount > 0) {
				notice(`已装载 ${ruleCount} 条审批规则（这些操作不会再询问）`, "info");
			}
			await refreshPiSessions(true);
			pushSnapshot();
		},

		refreshPiSessions,

		snapshot() {
			return buildSnapshot(state);
		},

		state() {
			return state;
		},

		isBusy() {
			return inFlight;
		},

		notify(text, level = "info") {
			notice(text, level);
		},

		async sendMessage(text: string) {
			if (inFlight) {
				notice("另一个回合正在跑，先等它结束或点「停止」", "warn");
				return { ok: false, error: { code: "session.busy", message: "已有回合在跑（ADR-0005：全局 1 路）" } };
			}

			inFlight = true;
			try {
				const conversationId = await ensureConversation(text);
				await loadConversationMessages(options.store, state, loadedConversations, conversationId, (message) =>
					notice(message, "warn"),
				);
				// 先建引擎会话（带上历史），再把新消息加进状态 —— 顺序反了会让新消息在历史里重复
				await binding.ensure(conversationId);
				const ts = now();
				const userMessage = appendText(createMessage(nextId("msg"), "user", ts), text);
				const assistantMessage = createMessage(nextId("msg"), "assistant", ts);

				// 首条用户消息决定标题（ADR-0005）
				const isFirstMessage = (state.messages[conversationId] ?? []).length === 0;
				if (isFirstMessage) {
					const title = deriveTitle(text, titleChars);
					await options.store.rename(conversationId, title, ts);
					renameConversation(state, conversationId, title);
				}

				state.messages[conversationId] = [...(state.messages[conversationId] ?? []), userMessage, assistantMessage];
				state.running = { status: "streaming", turnStartedAt: ts, streamingText: "", activeTool: null };
				currentTurn = { conversationId, messageId: assistantMessage.id };
				updateConversationMeta(state, conversationId, now());

				// 用户消息立即落盘（这样即使这一轮崩了，输入也不会丢）
				await options.store.appendMessage(conversationId, userMessage);
				pushSnapshot();

				await options.engine.sendMessage(conversationId, text, (event) => {
					applyEngineEvent(turnContext, { conversationId, messageId: assistantMessage.id, event });
				});
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`回合执行失败：${message}`, "error");
				state.running = { ...emptyRunning(), status: "error" };
				currentTurn = null;
				pushSnapshot();
				return { ok: false, error: { code: "session.turn_failed", message } };
			} finally {
				// 等落盘完成再放开「在飞」闸门：下一次回合不应该与上一次的持久化重叠
				if (finishPromise) {
					await finishPromise;
					finishPromise = null;
				}
				inFlight = false;
			}
		},

		async interrupt() {
			// 中断的是**在飞的那个回合**，不一定是你正在看的那个会话（可以切走再停）
			const target = currentTurn?.conversationId ?? state.activeId;
			if (!inFlight || !target) {
				return { ok: false, error: { code: "session.idle", message: "当前没有在跑的回合" } };
			}
			await options.engine.interrupt(target);
			return { ok: true };
		},

		approve(requestId, decision) {
			const result = approval.approve(requestId, decision);
			if (result.ok) pushSnapshot();
			return result;
		},

		async newConversation() {
			try {
				await createConversationInternal("新对话");
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`新建会话失败：${message}`, "error");
				return { ok: false, error: { code: "session.create_failed", message } };
			}
		},

		async switchConversation(conversationId) {
			if (!state.conversations.some((conversation) => conversation.id === conversationId)) {
				return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
			}
			if (state.activeId !== conversationId) {
				await loadConversationMessages(options.store, state, loadedConversations, conversationId, (message) =>
					notice(message, "warn"),
				);
				state.activeId = conversationId;
				pushSnapshot();
			}
			return { ok: true };
		},
	};
}
