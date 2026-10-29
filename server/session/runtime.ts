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
import { startUpstreamVersionWatch } from "../util/upstream-version.js";
import { newConversationWith } from "./conversation-create.js";
import { renameSessionWith } from "./rename-session.js";
import { createTitleSuggester } from "./suggest-title.js";
import { createSnapshotFor } from "./snapshot-for.js";
import { createSubagentBridge } from "./subagents.js";
import { createSwitchConversation } from "./switch-conversation.js";
import { createModelController, createModelRefresher } from "./model-controller.js";
import { createPiSessionOpener } from "./pi-opener.js";
import { createSessionDeleter } from "./delete-session.js";
import { createSessionMover } from "./move-session.js";
import { createPersistConversation } from "./persist-ephemeral.js";
import { createCloseEphemeral } from "./close-ephemeral.js";
import { createForkSession } from "./fork-session.js";
import { createTurnSender } from "./turn-send.js";
import { createSessionsRefresher } from "./pi-refresh.js";
import { applySettingsPatch, defaultSettings } from "./settings.js";
import { createTurnContext } from "./turn-events.js";
import { createEngineSwitcher, engineOptionsFor } from "./engine-switch.js";
import { createSwitchableEngine } from "../engine/switchable.js";
import { createEngineVersionProber } from "../engine/engine-versions.js";
import { conversationId as newConversationId, makeIdFactory } from "../util/ids.js";
import {
	approvalModeOf,
	buildSnapshot,
	createServerState,
	emptyRunning,
	forgetApprovalModeOf,
	setApprovalModeOf,
	touchConversationIn,
} from "../snapshot/state.js";
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

	const state = createServerState(options.workspace, options.engineName ?? "pi", options.approvalMode ?? "allow");
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
	state.versions = { web: webVersion(), engine: engine.version?.() ?? null, latest: null }; // 抬头显示的版本号

	/**
	 * 引擎版本表（切换面板每一行右上角那串 `v0.16.2`）。
	 *
	 * 只探**其余引擎**的版本是拿不到握手结果的（那要起子进程），所以走一次轻量探测（`--version` /
	 * 适配器的 package.json，见 engine/engine-versions.ts）；当前引擎连上之后握手给的值更准，
	 * 通过 `remember` 盖上去。
	 */
	const engineVersions = createEngineVersionProber({
		descriptors: () => options.engines?.descriptors() ?? [],
		onLog: (text) => options.onStartupInfo?.(text),
	});
	/** 用最新的版本表重算引擎清单（不给它们各自那一格，面板就只剩当前那个有版本号） */
	const rebuildEngineOptions = (): void => {
		state.engines = engineOptionsFor(
			state.engine,
			state.engineCapabilities,
			options.engines?.descriptors(),
			state.engineVersions,
		);
	};
	const rememberEngineVersion = (name: string, version: string | null): void => {
		engineVersions.remember(name, version);
		if (version) state.engineVersions = { ...state.engineVersions, [name]: version };
	};

	/** sendMessage 自引用：队列排空时要能再次调用自己（对象字面量还没构建完成 → 用 ref） */
	let apiRef: Runtime | null = null;

	const pushSnapshot = () => options.emit.snapshot(buildSnapshot(state));

	// 子代理（多开 + 模板管理）：引擎跑、宿主投影进快照；模板与开关落 ~/.pi/agent/agents
	const subagentBridge = createSubagentBridge({
		agentDir: options.subagentAgentDir ?? options.workspace,
		engine,
		state,
		pushSnapshot,
		onNotice: (text, level) => notice(text, level),
	});

	// 上游有没有新版本（抬头那行标红用）：后台查，拿到值才推一帧；
	// 离线/超时一直拿不到就一直是 null —— 界面不标红，功能一个不受影响
	startUpstreamVersionWatch((latest) => {
		state.versions = { ...state.versions, latest };
		pushSnapshot();
	});

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
			/**
			 * 只有「这一轮真的还在跑」时才翻状态。
			 *
			 * 回合收尾的顺序是：先把 `running` 置回 idle → 再 `cancelPending()` 清队列，
			 * 而队列一变空就会走到这里。以前无条件赋 `streaming`，等于把**已经结束**的回合
			 * 又改回「工作中」：状态栏一直转圈，客户端还会看到一个假的「流式→空闲」跳变
			 * （语音播报就挂在那个跳变上，于是同一个任务被播好几次）。
			 * `runningByConversation` 才是「这轮还在不在跑」的权威标记（开跑时写、收尾时删）。
			 */
			const current = state.running.conversationId;
			const stillRunning = current !== null && state.runningByConversation[current] !== undefined;
			if (stillRunning) state.running.status = nextPending ? "awaiting_approval" : "streaming";
			pushSnapshot();
		},
		isWaitingForUser: () => state.pendingApproval !== null,
		// 审批模式按会话存（state.approvalByConversation）：桥在放行前现读，不自己缓存
		modeOf: (conversationId) => approvalModeOf(state, conversationId),
	});
	const { notice, approval, watchdog } = services;

	/** 更新会话元数据（只在内存里，不再有自建索引） */
	const touchConversation = (conversationId: string, patch: { title?: string } = {}): void =>
		touchConversationIn(state, conversationId, now(), patch);

	const piOpener = createPiSessionOpener({
		engine,
		onModel: (model, conversationId) => {
			// 按会话落账（快照按会话取这份）；`state.model` 只当「新会话的起点」
			state.modelByConversation[conversationId] = model;
			state.model = model;
			pushSnapshot();
		},
		onError: (message) => notice(message, "error"),
		// 跑着回合 / 等着审批的会话不能回收（关掉 = 把一轮对话拦腰砍断）
		isBusy: (conversationId) => turns.has(conversationId),
		// 临时会话只活在内存里：关了句柄就真丢了（普通会话还能从文件重新打开）
		isPinned: (conversationId) => state.conversations.some((item) => item.id === conversationId && item.ephemeral),
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
			void refreshStats(id);
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

	const { queue, busy, flushSteer } = createTurnPlumbing({
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
		// 插队注入前要确认「这一轮真的还在跑」（见 turn-queue 的 flushSteer）
		isTurnRunning: (conversationId) => turns.has(conversationId),
		// 插队只对「底层协议真有 steer 语义」的引擎成立（目前只有 pi，ADR-0043）：
		// 不能插队就降级成排队，不要自己去覆盖引擎的活跃回合（codex 会永久 busy）
		supportsSteer: () => state.engineCapabilities.steer === true,
	});

	const finishTurn = createRuntimeTurnFinisher({
		state,
		turns,
		nextId,
		now,
		shiftQueued: (conversationId) => queue.shift(conversationId),
		sendNext: (message, conversationId) =>
			setTimeout(() => void apiRef?.sendMessage(message.text, message.attachments, "now", conversationId), 0),
		cancelPending: (conversationId, cancelOptions) => approval.cancelPending(conversationId, cancelOptions),
		onTurnFinished: options.onTurnFinished,
		touchConversation: (conversationId) => touchConversation(conversationId),
		refreshStats: (id) => void refreshStats(id),
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
		// 挂着的插队：一到「一步结束」就真插进去
		steerAtBoundary: (conversationId) => flushSteer(conversationId),
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
		// 这个会话的子代理也要停：删掉的会话不该还在后台烧 token
		void subagentBridge.stopAll(conversationId);
		state.queued = state.queued.filter((item) => item.conversationId !== conversationId);
		setRunning(state, conversationId, null);
		turns.delete(conversationId);
		// 会话没了，它的审批模式与统计缓存也一起丢掉（别留指向不存在会话的记录）
		forgetApprovalModeOf(state, conversationId);
		delete state.statsByConversation[conversationId];
		if (state.activeId === conversationId) {
			state.activeId = state.conversations[0]?.id ?? null;
			state.running = emptyRunning();
			delete state.actionsByConversation[conversationId];
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

	/** 把会话拖到另一个项目：改文件 header 的 cwd + 搬目录（见 move-session.ts） */
	const moveSession = createSessionMover({
		engine,
		projects: () => state.piProjects,
		handleOf: (id) => piOpener.handleOf(id),
		isBusy: (id) => turns.has(id),
		forget: (id) => piOpener.forget(id),
		relabel: (id, workspace) => {
			state.conversations = state.conversations.map((conversation) =>
				conversation.id === id ? { ...conversation, workspace } : conversation,
			);
		},
		refresh: () => piRefresher.refresh(true),
		pushSnapshot,
		notice,
	});

	/** 临时会话转正（「保存为正式对话」）：原生导出落盘后清掉临时标记 */
	const persistConversation = createPersistConversation({
		engine,
		conversations: () => state.conversations,
		register: (input) => piOpener.register(input),
		refreshSessions: (force) => piRefresher.refresh(force),
		clearEphemeral: (conversationId) => {
			state.conversations = state.conversations.map((item) => {
				if (item.id !== conversationId) return item;
				const { ephemeral: _temporary, ...rest } = item;
				return rest;
			});
		},
		isBusy: (conversationId) => turns.has(conversationId),
		notice,
		pushSnapshot,
	});

	/** 关闭临时会话（「关闭」）：没有文件可删，只把内存里的东西放掉（见 close-ephemeral.ts） */
	const closeEphemeral = createCloseEphemeral({
		conversations: () => state.conversations,
		isBusy: (conversationId) => turns.has(conversationId),
		discard: discardConversation,
		notice,
		pushSnapshot,
	});

	/** 从某条消息派生新会话（分支）：原会话不动，自动切到新的那条 */
	const forkSession = createForkSession({
		create: (seedText, workspace, seed) => conversations.create(seedText, workspace, seed),
		conversations: () => state.conversations,
		infoOf: (id) => piOpener.infoOf(id),
		open: async (id) => (await piOpener.open(id, (force) => piRefresher.refresh(force))) !== null,
		clientView,
		notice,
		pushSnapshot,
		refreshSessions: (force) => piRefresher.refresh(force),
	});

	const switchEngine = createEngineSwitcher({
		state,
		slot,
		engines: options.engines ?? null,
		sessionsSlot: sessionsRefresher.slot,
		clientView,
		clearSessions: () => piOpener.clear(),
		approvalHandler: approval.handler,
		rememberVersion: rememberEngineVersion,
		cancelAllPending: () => approval.cancelPending(null, { allTurnsDone: true }),
		refreshModels,
		refreshSessions: (force) => piRefresher.refresh(force),
		loadProviders: options.loadProviders ?? null,
		isBusy: () => turns.size > 0,
		notice,
		pushSnapshot,
	});

	/** 改名（双击改名 / 菜单里的「重命名」/ AI 起名 共用同一条路） */
	const renameSession = (conversationId: string, title: string) =>
		renameSessionWith({
			engine,
			handleOf: (id) => piOpener.handleOf(id),
			refresh: () => piRefresher.refresh(true),
			onRenamed: (id, title) => touchConversation(id, { title }),
			notice,
			pushSnapshot,
		})(conversationId, title);

	/**
	 * 「让 AI 按会话内容起个名」（顶栏标题前那枚气泡图标点一下就跑这个）。
	 *
	 * 消息优先用内存里那份（用户正看着这条，本来就在），没加载过就让引擎读转录 ——
	 * 跟对话区同一个事实源，不另抄一份。改名复用 `renameSession`：写进 pi 的
	 * `session_info`，侧栏 / 顶栏 / CLI 看到的是同一个名字。
	 */
	const suggestSessionTitle = createTitleSuggester({
		messagesOf: async (conversationId) => {
			const loaded = state.messages[conversationId];
			if (loaded && loaded.length > 0) return loaded;
			return engine.readUiMessages(conversationId).catch(() => []);
		},
		suggest: async (prompt) => {
			if (!engine.suggestTitle) throw new Error("当前引擎不支持 AI 起名");
			return engine.suggestTitle(prompt);
		},
		rename: async (conversationId, title) => {
			const result = await renameSession(conversationId, title);
			return result.ok ? { ok: true, title } : result;
		},
	});

	const api: Runtime = {
		async init() {
			const ruleCount = await approval.loadRules(); // 「总是允许」规则只记日志，不占对话流
			if (ruleCount > 0) options.onStartupInfo?.(`已装载 ${ruleCount} 条审批规则（这些操作不会再询问）`);
			state.settings = settings ? await settings.load() : defaultSettings();
			subagentBridge.init();
			await piRefresher.refresh(true);
			await apiRef?.refreshProviders();
			pushSnapshot();
			// 引擎版本表：后台探，探到就推一帧（探不到就不动 —— 面板只是少一行字）
			void engineVersions
				.refresh()
				.then((map) => {
					state.engineVersions = { ...map, ...state.engineVersions };
					rebuildEngineOptions();
					pushSnapshot();
				})
				.catch(() => undefined);
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

		/**
		 * 模型测速：**当时**的引擎说了算（切引擎后按钮自然落到新引擎上）。
		 * 只有实现了 `probeModel` 的引擎能测 —— pi 的测速在 provider 面板，走的是另一条
		 * 专门的 HTTP 路径（工作台自己持有 key），这里不该拿 pi 去冒充。
		 */
		async probeModel(modelId: string) {
			const port = slot.current();
			if (!port.probeModel) {
				return {
					ok: false as const,
					message: `当前引擎（${state.engine}）不支持测速：它的凭证在引擎自己手里，工作台没法发最小请求`,
				};
			}
			return port.probeModel(modelId);
		},
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
			/**
			 * 只停「确实在跑」的那条，**不再兜底到任意一条**。
			 *
			 * 旧写法在 `requested` 不在 turns 里时会退到 `[...turns.keys()][0]`：用户点停一个
			 * 刚好收尾的会话，被中断的却是另一个正在跑的会话（A 的工作被半路砍掉，
			 * 还弹一句「回合已中断」）。宁可返回“没有在跑的回合”，也不能停错人。
			 */
			const target = requested
				? turns.has(requested)
					? requested
					: null
				: state.activeId !== null && turns.has(state.activeId)
					? state.activeId
					: null;
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

		// 审批模式跟着**会话**走：界面传自己正看着那条会话，没传（老客户端）就落到全局 activeId
		setApprovalMode(mode, conversationId) {
			setApprovalModeOf(state, conversationId ?? state.activeId, mode);
			pushSnapshot();
			return { ok: true };
		},

		setEngine: async (name) => {
			const result = await switchEngine(name);
			// 新引擎的子代理能力可能没有：旧记录清掉，面板改订阅它的（没能力就不显示模块）
			subagentBridge.engineChanged();
			return result;
		},

		// 子代理：面板的四个动作（停运行 / 存模板 / 删模板 / 改开关）
		interruptSubagent: (runId) => subagentBridge.interrupt(runId),
		saveSubagentProfile: (profile) => subagentBridge.saveProfile(profile),
		deleteSubagentProfile: (profileId) => subagentBridge.deleteProfile(profileId),
		setSubagentSettings: (patch) => subagentBridge.applySettings(patch),

		newConversation: (workspace, clientId, seed) =>
			newConversationWith({ create: conversations.create, clientView, notice, pushSnapshot })(
				workspace,
				clientId,
				seed,
			),

		persistConversation: (conversationId) => persistConversation(conversationId),

		closeEphemeral: (conversationId) => closeEphemeral(conversationId),

		forkSession: (conversationId, messageId, clientId) => forkSession(conversationId, messageId, clientId),

		deleteSession: (conversationId) => deleteSession(conversationId),

		moveSession: (conversationId, workspace) => moveSession(conversationId, workspace),

		renameSession: (conversationId, title) => renameSession(conversationId, title),

		suggestSessionTitle: (conversationId) => suggestSessionTitle(conversationId),

		switchConversation: (conversationId, clientId) => switchTo(conversationId, clientId),
	};
	apiRef = api; // 队列排空时要能再调 sendMessage
	return api;
}
