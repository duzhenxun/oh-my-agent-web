/** 会话运行时：引擎事件 → UI 状态 / 协议事件，并把转录落盘。规则见 ADR。 */
import { createMarkerStreamFilter } from "../markers/actions.js";
import { createRefreshActions } from "./refresh-actions.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import { createRuntimeServices } from "./runtime-services.js";
import { createStatsRefresher } from "./stats-refresher.js";
import { createThrottle } from "./throttle.js";
import { createRuntimeTurnFinisher, setRunning } from "./turn-finish.js";
import { cancelQueuedWith, createTurnPlumbing } from "./turn-queue.js";
import { createConversationFactory } from "./conversation-create.js";
import { createClientView } from "./client-view.js";
import { webVersion } from "../util/version.js";
import { newConversationWith } from "./conversation-create.js";
import { renameSessionWith } from "./rename-session.js";
import { createSnapshotFor } from "./snapshot-for.js";
import { createSwitchConversation } from "./switch-conversation.js";
import { createModelController, createModelRefresher } from "./model-controller.js";
import { createPiSessionOpener } from "./pi-opener.js";
import { createSessionDeleter } from "./delete-session.js";
import { createTurnSender } from "./turn-send.js";
import { createSessionsRefresher } from "./pi-refresh.js";
import { applySettingsPatch, defaultSettings } from "./settings.js";
import { createTurnContext } from "./turn-events.js";
import { createEngineSwitcher, engineOptionsFor } from "./engine-switch.js";
import { createSwitchableEngine } from "../engine/switchable.js";
import { conversationId as newConversationId, makeIdFactory } from "../util/ids.js";
import { buildSnapshot, createServerState, emptyRunning, touchConversationIn } from "../snapshot/state.js";
export type { Result, Runtime, RuntimeEmit } from "./runtime-types.js";
import type { Runtime, RuntimeOptions } from "./runtime-types.js";
export type { RuntimeOptions } from "./runtime-types.js";

export function createRuntime(options: RuntimeOptions): Runtime {
	const now = options.now ?? (() => Date.now());
	const settings = options.settings;
	const titleChars = options.titleChars ?? 24;
	/** 「下一步」生成建议的超时（默认 20s；测试可调小） */
	const actionsTimeoutMs = options.actionsTimeoutMs ?? 20_000;

	// 引擎槽：下游模块拿到的都是这个稳定代理，切引擎时不用重建任何一个
	const slot = createSwitchableEngine(options.engine);
	const engine = slot.port;

	const state = createServerState(options.workspace, options.engineName ?? "pi");
	if (options.engineCapabilities) state.engineCapabilities = { ...options.engineCapabilities };
	state.engines = engineOptionsFor(
		options.engineName ?? "pi",
		state.engineCapabilities,
		options.engines?.descriptors(),
	);
	state.files = { root: options.workspace, treeVersion: 0 };

	// 默认真实运行用全局唯一 id（ADR-0019）；测试注入确定性 id
	const nextId = options.idSeq ?? makeIdFactory();
	// 按会话的在飞回合（ADR-0030 ③）：有条目 = 这个会话有回合在跑（isBusy 也看它）
	type TurnState = {
		messageId: string;
		filter: ReturnType<typeof createMarkerStreamFilter>;
		rawText: string;
	};
	const turns = new Map<string, TurnState>();
	const clientView = createClientView(); // 每客户端在看哪个会话（ADR-0033）
	state.versions = { web: webVersion(), engine: engine.version?.() ?? null }; // 抬头显示的版本号

	/** sendMessage 自引用：队列排空时要能再次调用自己（对象字面量还没构建完成 → 用 ref） */
	let apiRef: Runtime | null = null;

	const pushSnapshot = () => options.emit.snapshot(buildSnapshot(state));

	// 历史会话清单的刷新节奏（ADR-0021 §1）：来源可换（切引擎），节奏与缓存只有一份
	const sessionsRefresher = createSessionsRefresher({
		initial: options.piSessions ?? null,
		state,
		minIntervalMs: options.piSessionsMinIntervalMs,
		now,
		remember: (projects) => piOpener.remember(projects),
		onChanged: pushSnapshot,
		onError: (message) => notice(message, "warn"),
	});
	const piRefresher = { refresh: sessionsRefresher.refresh };

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

	/** 更新会话元数据（只在内存里，不再有自建索引） */
	const touchConversation = (conversationId: string, patch: { title?: string } = {}): void =>
		touchConversationIn(state, conversationId, now(), patch);

	const piOpener = createPiSessionOpener({
		engine,
		onModel: (model) => {
			state.model = model;
			pushSnapshot();
		},
		onError: (message) => notice(message, "error"),
	});

	const conversations = createConversationFactory({
		state,
		engine,
		opener: piOpener,
		nextId,
		// 会话 id 与 pi 一致用 UUID；测试注入确定性 id 时仍走 `conv-N`（断言好写）
		newConversationId: options.idSeq ? () => nextId("conv") : newConversationId,
		now,
		titleChars,
		defaultModelFor: (workspace) => state.settings.defaultModels[workspace] ?? piOpener.projectModel(workspace), // 项目默认 > 该项目最近会话，见 conversation-create
		onReady: (id) => {
			void models.refresh(id);
			void refreshStats();
			void models.refreshThinking(id);
			// 新会话可能刚让引擎创建了一个项目（codex）：立刻重扫，侧栏不用等下一轮
			void piRefresher.refresh(true);
		},
	});
	const models = createModelController({
		engine,
		state,
		notice: (text, level) => notice(text, level),
		onChanged: pushSnapshot,
	});

	const turnContext = createTurnContext({
		state,
		now,
		pushSnapshot,
		emitEvent: (event) => options.emit.event(event),
		notice,
		onThinkingDelta: createThrottle(250, pushSnapshot), // 思考增量节流
		appendRawText: (chunk, conversationId) => {
			const turn = turns.get(conversationId);
			if (!turn) return "";
			return ((turn.rawText += chunk), turn.filter.push(chunk));
		},
		// 收尾全过程都是同步的状态更新（settle 立刻写内存、刷新另起），所以返回的 Promise
		// 不需要再被 await —— 以前留过一条「等落盘」的通道，但它把 Promise 挂在一个已经被
		// 删除的 turns 条目上，永远读不到（死代码，已删）。
		finish: (conversationId, reason) => void finishTurn(conversationId, reason),
	});

	const refreshStats = createStatsRefresher({
		state,
		pathOf: (id) => piOpener.pathOf(id),
		// 引擎自带统计（dsh 的日志）；pi / codex 走下面的文件路径兜底
		statsOf: async (id) => (await engine.sessionStats?.(id)) ?? null,
		onChanged: pushSnapshot,
	});

	const { queue, busy } = createTurnPlumbing({
		state,
		engine,
		nextId,
		appendUser: (id, value, steer) => {
			const message = appendText(createMessage(nextId("msg"), "user", now()), value);
			if (steer) message.steer = true;
			state.messages[id] = [...(state.messages[id] ?? []), message];
		},
		notice: (text, level) => notice(text, level),
		pushSnapshot,
	});

	const finishTurn = createRuntimeTurnFinisher({
		state,
		turns,
		nextId,
		now,
		shiftQueued: (conversationId) => queue.shift(conversationId),
		sendNext: (message, conversationId) =>
			setTimeout(() => void apiRef?.sendMessage(message.text, message.attachments, "now", conversationId), 0),
		cancelPending: () => approval.cancelPending(),
		onTurnFinished: options.onTurnFinished,
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
		// 切走的那条会话放开引擎写锁（codex）：否则 Codex 桌面端打不开它
		parkPrevious: (id) => {
			if (turns.has(id)) return;
			void engine.parkSession?.(id).catch(() => undefined);
		},
		pushSnapshot,
		report: (text) => options.onStartupInfo?.(text), // 只写日志，不进对话流（切会话慢时靠它定位）
	});

	const refreshModels = createModelRefresher({ engine, state });

	const refreshActions = createRefreshActions({
		state,
		turns,
		engine,
		notice,
		pushSnapshot,
		sendTurn: (prompt, conv) => sendTurn(prompt, undefined, "now", conv, undefined, { hidden: true }),
		// 设置里的「最大超时」优先；没有/非法就退回启动参数（默认 20s）
		timeoutMs: () => {
			const seconds = state.settings.thinkTimeoutSec;
			return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : actionsTimeoutMs;
		},
	});

	const sendTurn = createTurnSender({
		state,
		engine,
		now,
		nextId,
		titleChars,
		turns,
		watchdog,
		turnContext,
		notice,
		pushSnapshot,
		finishTurn: (id, reason) => finishTurn(id, reason),
		busy,
		createConversation: (seed) => conversations.create(seed),
		openConversation: (id, refresh) => piOpener.open(id, refresh),
		isOpen: (id) => piOpener.isOpen(id),
		refreshProjects: (force) => piRefresher.refresh(force),
		refreshModels: (id) => models.refresh(id),
		refreshThinking: (id) => models.refreshThinking(id),
		clientView,
		touchConversation,
		uploadStore: options.uploadStore,
	});

	/**
	 * 删除会话后的**本地清场**。
	 *
	 * 只把磁盘文件改名不够：内存里的会话/消息/排队项、pi-opener 的「已打开」记录、
	 * 引擎会话句柄都还在 —— 表现就是「删了还在侧栏、点进去还能读、还能发消息」。
	 */
	const discardConversation = (conversationId: string): void => {
		clientView.forget(conversationId);
		piOpener.forget(conversationId);
		state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
		const { [conversationId]: _messages, ...remainingMessages } = state.messages;
		state.messages = remainingMessages;
		state.queued = state.queued.filter((item) => item.conversationId !== conversationId);
		setRunning(state, conversationId, null);
		turns.delete(conversationId);
		if (state.activeId === conversationId) {
			state.activeId = state.conversations[0]?.id ?? null;
			state.running = emptyRunning();
			state.actions = [];
		}
		// 引擎侧的句柄也放开：否则它继续占着会话（还能被写进那个已改名的文件）
		Promise.resolve(engine.closeSession?.(conversationId)).catch(() => undefined);
	};

	const deleteSession = createSessionDeleter({
		engine,
		projects: () => state.piProjects,
		handleOf: (id) => piOpener.handleOf(id),
		discard: discardConversation,
		refresh: () => piRefresher.refresh(true),
		pushSnapshot,
	});

	const switchEngine = createEngineSwitcher({
		state,
		slot,
		engines: options.engines ?? null,
		sessionsSlot: sessionsRefresher.slot,
		clientView,
		clearSessions: () => piOpener.clear(),
		approvalHandler: approval.handler,
		refreshModels,
		refreshSessions: (force) => piRefresher.refresh(force),
		loadProviders: options.loadProviders ?? null,
		isBusy: () => turns.size > 0,
		notice,
		pushSnapshot,
	});

	const api: Runtime = {
		async init() {
			const ruleCount = await approval.loadRules(); // 「总是允许」规则只记日志，不占对话流
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
			await refreshModels(); // 模型表挂在会话上：先保证有会话，再重读
			// provider 配置是 pi 独有的（models-store.json）：别的引擎不碰这张表
			const ownConfig = options.engines?.get(state.engine)?.descriptor.providerConfig !== false;
			if (options.loadProviders && ownConfig) state.providers = await options.loadProviders();
		},

		snapshot: () => buildSnapshot(state),
		snapshotFor: createSnapshotFor({ state, clientView, now }),
		clientView,
		state: () => state,

		isBusy() {
			return turns.size > 0;
		},

		notify(text, level = "info") {
			notice(text, level);
		},

		sendMessage: sendTurn,

		async interrupt(requested?: string) {
			// 优先停用户点的那条（前端会把当前会话带上来），否则用当前会话，最后兜底任意一条
			const fallback =
				(requested && turns.has(requested) ? requested : undefined) ??
				(state.activeId !== null && turns.has(state.activeId) ? state.activeId : [...turns.keys()][0]);
			const target = fallback ?? null;
			if (!target) {
				return { ok: false, error: { code: "session.idle", message: "当前没有在跑的回合" } };
			}
			await engine.interrupt(target);
			return { ok: true };
		},

		approve(requestId, decision) {
			const result = approval.approve(requestId, decision);
			if (result.ok) pushSnapshot();
			return result;
		},

		// 没显式指定条数时用设置里的「一次生成几条」（手机端仍会自己传 3）
		refreshActions: (conversationId?: string, count?: number) =>
			refreshActions(conversationId, count ?? state.settings.thinkCount),

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

		setEngine: (name) => switchEngine(name),

		newConversation: newConversationWith({ create: conversations.create, clientView, notice, pushSnapshot }),

		deleteSession: (conversationId) => deleteSession(conversationId),

		renameSession: (conversationId, title) =>
			renameSessionWith({
				engine,
				handleOf: (id) => piOpener.handleOf(id),
				refresh: () => piRefresher.refresh(true),
				onRenamed: (id, title) => touchConversation(id, { title }),
				notice,
				pushSnapshot,
			})(conversationId, title),

		switchConversation: (conversationId, clientId) => switchTo(conversationId, clientId),
	};
	apiRef = api; // 队列排空时要能再调 sendMessage
	return api;
}
