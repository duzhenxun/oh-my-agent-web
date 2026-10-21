/** 会话运行时：引擎事件 → UI 状态 / 协议事件，并把转录落盘。规则见 ADR。 */
import { createMarkerStreamFilter } from "../markers/actions.js";
import { createRuntimeServices } from "./runtime-services.js";
import { createStatsRefresher } from "./stats-refresher.js";
import { createThrottle } from "./throttle.js";
import { awaitTurnPersisted, createTurnFinisher, setRunning, settleWith } from "./turn-finish.js";
import { cancelQueuedWith, createTurnPlumbing } from "./turn-queue.js";
import { createConversationFactory } from "./conversation-create.js";
import { createClientView } from "./client-view.js";
import { createSwitchConversation } from "./switch-conversation.js";
import { resolveAttachments } from "./attachment-resolve.js";
import { createModelController } from "./model-controller.js";
import { createPiSessionOpener } from "./pi-opener.js";
import { createPiRefresher } from "./pi-refresh.js";
import { applySettingsPatch, defaultSettings } from "./settings.js";
import { applyEngineEvent, type TurnEventContext } from "./turn-events.js";
import { makeIdFactory } from "../util/ids.js";
import type {
	AttachmentRef, // 附件引用（ADR-0020 §P3）
	SendMode,
} from "../protocol.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import { buildSnapshot, createServerState, emptyRunning } from "../snapshot/state.js";
export type { Result, Runtime, RuntimeEmit } from "./runtime-types.js";
import type { Runtime, RuntimeOptions } from "./runtime-types.js";
export type { RuntimeOptions } from "./runtime-types.js";

export function createRuntime(options: RuntimeOptions): Runtime {
	const now = options.now ?? (() => Date.now());
	const settings = options.settings;
	const titleChars = options.titleChars ?? 24;

	const state = createServerState(options.workspace, options.engineName ?? "pi");
	if (options.engineCapabilities) state.engineCapabilities = { ...options.engineCapabilities };
	state.files = { root: options.workspace, treeVersion: 0 };

	// 默认真实运行用全局唯一 id（ADR-0019）；测试注入确定性 id
	const nextId = options.idSeq ?? makeIdFactory();
	// 按会话的在飞回合（ADR-0030 ③）：finish 是落盘 Promise，sendMessage 返回前要等它
	type TurnState = {
		messageId: string;
		filter: ReturnType<typeof createMarkerStreamFilter>;
		rawText: string;
		finish?: Promise<void>;
	};
	const turns = new Map<string, TurnState>();
	const clientView = createClientView(); // 每客户端在看哪个会话（ADR-0033）

	/** sendMessage 自引用：队列排空时要能再次调用自己（对象字面量还没构建完成 → 用 ref） */
	let apiRef: Runtime | null = null;

	const pushSnapshot = () => options.emit.snapshot(buildSnapshot(state));

	// pi 已有会话列表的刷新节奏（ADR-0021 §1）：首扫立刻，之后带最小间隔（扫描器自带缓存）
	const piRefresher = createPiRefresher({
		list: () => options.piSessions?.() ?? Promise.resolve([]),
		minIntervalMs: options.piSessionsMinIntervalMs,
		now,
		onLoaded: (projects) => {
			state.piProjects = projects;
			// 记下每个 pi 会话的文件路径（ADR-0021 §2：点开就是打开这个文件）
			piOpener.remember(projects);
			pushSnapshot();
		},
		onError: (message) => notice(message, "warn"),
	});

	const services = createRuntimeServices({
		options,
		now,
		nextId,
		onNotice: (entry) => {
			// 按 id upsert：同 key 的提示是「替换」原行，不能当新行追加（否则同一 id 出现两次）
			state.notices = [...state.notices.filter((item) => item.id !== entry.id), entry].slice(
				-(options.maxNotices ?? 20),
			);
			options.emit.event({ type: "event", event: "notice", notice: entry });
			pushSnapshot();
		},
		onPending: (nextPending) => {
			state.pendingApproval = nextPending;
			state.running.status = nextPending ? "awaiting_approval" : "streaming";
			pushSnapshot();
		},
		isWaitingForUser: () => state.pendingApproval !== null,
	});
	const { notice, approval, watchdog } = services;

	// 引擎会话的生命周期（懒创建 + 历史注入 + 读模型），见 ADR-0018

	/** 更新会话元数据（只在内存里，不再有自建索引） */
	function touchConversation(conversationId: string, patch: { title?: string } = {}): void {
		state.conversations = state.conversations.map((conversation) =>
			conversation.id === conversationId
				? {
						...conversation,
						...patch,
						updatedAt: now(),
						messageCount: state.messages[conversationId]?.length ?? conversation.messageCount,
					}
				: conversation,
		);
	}

	const piOpener = createPiSessionOpener({
		engine: options.engine,
		onModel: (model) => {
			state.model = model;
			pushSnapshot();
		},
		onError: (message) => notice(message, "error"),
	});

	// 新建会话（ADR-0021 §2 收尾）：落在 pi 的会话存储里 —— 抽在 conversation-create 里
	const conversations = createConversationFactory({
		state,
		engine: options.engine,
		opener: piOpener,
		nextId,
		now,
		titleChars,
		onReady: (id) => {
			void models.refresh(id);
			void refreshStats();
			void models.refreshThinking(id);
		},
	});
	// 模型列表与切换（ADR-0020 §P2）：抽在 model-controller 里
	const models = createModelController({
		engine: options.engine,
		state,
		notice: (text, level) => notice(text, level),
		onChanged: pushSnapshot,
	});

	const turnContext: TurnEventContext = {
		state,
		now,
		onTextDelta: (chunk, conversationId) => {
			const turn = turns.get(conversationId);
			if (!turn) return "";
			return ((turn.rawText += chunk), turn.filter.push(chunk));
		},
		emitEvent: (event) => options.emit.event(event),
		pushSnapshot,
		notice,
		onThinkingDelta: createThrottle(250, pushSnapshot), // 思考增量节流
		onTurnEnd: (conversationId, reason) => {
			const turn = turns.get(conversationId);
			const promise = finishTurn(conversationId, reason);
			if (turn) turn.finish = promise;
		},
	};

	const refreshStats = createStatsRefresher({
		activeId: () => state.activeId,
		pathOf: (id) => piOpener.pathOf(id),
		projects: () => state.piProjects,
		setStats: (stats) => {
			state.sessionStats = stats;
			// 会话级缓存：别的标签页看自己的会话时不会读到别人那份
			if (state.activeId) state.statsByConversation[state.activeId] = stats;
		},
		onChanged: pushSnapshot,
	});

	const { queue, busy } = createTurnPlumbing({
		state,
		engine: options.engine,
		nextId,
		appendUser: (id, value) =>
			void (state.messages[id] = [
				...(state.messages[id] ?? []),
				appendText(createMessage(nextId("msg"), "user", now()), value),
			]),
		notice: (text, level) => notice(text, level),
		pushSnapshot,
	});

	const finishTurn = createTurnFinisher({
		state,
		turns,
		shiftQueued: (conversationId) => queue.shift(conversationId),
		sendNext: (message, conversationId) =>
			setTimeout(() => void apiRef?.sendMessage(message.text, message.attachments, "now", conversationId), 0),
		cancelPending: () => approval.cancelPending(),
		settle: (info) => {
			settleWith(state, nextId)(info);
			// 回合收尾：通知宿主（推送「已完成」给订阅者）
			options.onTurnFinished?.({
				conversationId: info.conversationId,
				title: state.conversations.find((item) => item.id === info.conversationId)?.title ?? "会话",
				failed: false,
			});
		},
		touchConversation: (conversationId) => touchConversation(conversationId),
		refreshStats: () => void refreshStats(),
		refreshProjects: () => void piRefresher.refresh(true),
		notice: (text, level) => notice(text, level),
		pushSnapshot,
	});

	const switchTo = createSwitchConversation({
		state,
		clientView,
		infoOf: (id) => piOpener.infoOf(id),
		open: (id, refresh) => piOpener.open(id, (force) => refresh(force ?? false)),
		refreshSessions: (force) => piRefresher.refresh(force),
		refreshModels: (id) => models.refresh(id),
		refreshThinking: (id) => models.refreshThinking(id),
		refreshStats: () => void refreshStats(),
		pushSnapshot,
		// 只写日志，不进对话流：切会话慢的时候要靠它定位
		report: (text) => options.onStartupInfo?.(text),
	});

	const api: Runtime = {
		async init() {
			// 装载的「总是允许」规则只写日志：启动信息不该占用对话流（用户明确要求过）
			const ruleCount = await approval.loadRules();
			if (ruleCount > 0) options.onStartupInfo?.(`已装载 ${ruleCount} 条审批规则（这些操作不会再询问）`);
			state.settings = settings ? await settings.load() : defaultSettings();
			await piRefresher.refresh(true);
			await apiRef?.refreshProviders();
			pushSnapshot();
		},

		async applySettings(patch) {
			await applySettingsPatch({
				state,
				store: settings,
				patch,
				onError: (message) => notice(message, "warn"),
			});
			pushSnapshot();
			return { ok: true };
		},

		refreshPiSessions: (force?: boolean) => piRefresher.refresh(force),
		refreshProviders: async () => {
			// pi 的模型表挂在会话上：先保证有会话，再让它重读配置
			await options.engine.prewarm?.();
			await options.engine.reloadModels?.();
			// 模型表也要跟着更新：provider 列表里的「内置」分组是从它推出来的
			const models = (await options.engine.listModels?.()) ?? [];
			if (models.length > 0) state.models = models;
			if (options.loadProviders) state.providers = await options.loadProviders();
		},

		snapshot() {
			return buildSnapshot(state);
		},

		snapshotFor: (clientId) => buildSnapshot(state, undefined, clientView.activeFor(clientId, state.activeId)),

		state() {
			return state;
		},

		isBusy() {
			return turns.size > 0;
		},

		notify(text, level = "info") {
			notice(text, level);
		},

		async sendMessage(
			text: string,
			attachments?: AttachmentRef[],
			mode: SendMode = "steer",
			targetConversationId?: string,
		) {
			// 附件解析（ADR-0020 §P3）
			const resolved = await resolveAttachments(text, attachments, options.uploadStore);
			for (const name of resolved.missing) notice(`附件已失效（可能过期被清理）：${name}`, "warn");
			if (resolved.images.length > 0) notice(`已附加 ${resolved.images.length} 张图片（走视觉注入）`, "info");

			if (state.activeId !== null && turns.has(state.activeId)) {
				const handled = await busy(mode, text, resolved.promptText, resolved.images, attachments);
				if (handled) return handled;
			}
			let conversationId: string | null = null;
			try {
				conversationId = targetConversationId ?? state.activeId ?? (await conversations.create(text));
				const conv = conversationId; // 非空别名（TS 收窄）
				if (!piOpener.isOpen(conv)) {
					const opened = await piOpener.open(conv, (force) => piRefresher.refresh(force));
					if (opened === null) throw new Error(`会话打不开：${conv}`);
					state.messages[conv] = opened;
					await models.refresh(conv);
					await models.refreshThinking(conv);
				}
				const ts = now();
				const userMessage = appendText(createMessage(nextId("msg"), "user", ts), text);
				const assistantMessage = createMessage(nextId("msg"), "assistant", ts);

				const isFirstMessage = (state.messages[conv] ?? []).length === 0;
				if (isFirstMessage) {
					touchConversation(conv, { title: text.replace(/\s+/g, " ").trim().slice(0, titleChars) });
				}

				state.messages[conv] = [...(state.messages[conv] ?? []), userMessage, assistantMessage];
				if (conv === state.activeId) {
					state.running = {
						status: "streaming",
						conversationId: conv,
						turnStartedAt: ts,
						streamingText: "",
						activeTool: null,
					};
				}
				state.actions = [];
				turns.set(conv, { messageId: assistantMessage.id, filter: createMarkerStreamFilter(), rawText: "" });
				setRunning(state, conv, { status: "streaming", turnStartedAt: ts });
				watchdog.start(conv);
				touchConversation(conv);

				pushSnapshot();

				await options.engine.sendMessage(
					conv,
					resolved.promptText,
					(event) => {
						applyEngineEvent(turnContext, { conversationId: conv, messageId: assistantMessage.id, event });
					},
					resolved.images.length > 0 ? { images: resolved.images } : undefined,
				);
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`回合执行失败：${message}`, "error");
				if (conversationId !== null && conversationId === state.activeId) {
					state.running = { ...emptyRunning(), status: "error" };
				}
				if (conversationId !== null) {
					turns.delete(conversationId);
					setRunning(state, conversationId, null);
				}
				pushSnapshot();
				return { ok: false, error: { code: "session.turn_failed", message } };
			} finally {
				if (conversationId !== null) {
					watchdog.stop(conversationId);
					await awaitTurnPersisted(turns, conversationId); // 等这一轮落盘，避免与下一轮重叠
				}
			}
		},

		async interrupt() {
			const fallback = state.activeId !== null && turns.has(state.activeId) ? state.activeId : [...turns.keys()][0];
			const target = fallback ?? null;
			if (!target) {
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

		setModel: (modelId) => models.switchTo(state.activeId, modelId),

		setThinkingLevel: (level) => models.setThinking(state.activeId, level),
		reloadModels: () => models.reload(state.activeId),

		cancelQueued: (queueId) => cancelQueuedWith(queue, queueId, notice),

		pushSnapshot, // 供 provider 等模块「只推帧、不造提示」

		setApprovalMode(mode) {
			approval.setMode(mode);
			state.approvalMode = mode;
			pushSnapshot();
			return { ok: true };
		},

		async newConversation(workspace?: string) {
			try {
				await conversations.create("新对话", workspace);
				pushSnapshot(); // ← 少了这一句，侧栏不会更新（冒烟抓到的）
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`新建会话失败：${message}`, "error");
				return { ok: false, error: { code: "session.create_failed", message } };
			}
		},

		switchConversation: (conversationId, clientId) => switchTo(conversationId, clientId),
	};
	apiRef = api; // 队列排空时要能再调 sendMessage
	return api;
}
