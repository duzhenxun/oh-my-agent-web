/**
 * 会话运行时（宿主侧）：把引擎事件翻译成 UI 状态 / 协议事件，并把转录落盘（M2）。
 *
 * 遵守的规则（都已由 ADR 定死）：
 *   - 回合进行中再发消息：默认引导、可选排队（这轮结束自动发）；
 *   - 快照只在**结构性变化**时推：正文靠 message_delta 增量（ADR-0004 §3）；
 *   - 转录**追加写**：用户消息发出时落盘；助手消息**在回合结束时**落盘（整条，不留半条）。
 */
import { createMarkerStreamFilter } from "../markers/actions.js";
import { createRuntimeServices } from "./runtime-services.js";
import { createStatsRefresher } from "./stats-refresher.js";
import { createThrottle } from "./throttle.js";
import { awaitTurnPersisted, createTurnFinisher, setRunning, settleWith } from "./turn-finish.js";
import { createBusyHandler, createTurnQueue, dequeueWith, enqueueWith } from "./turn-queue.js";
import { createConversationFactory } from "./conversation-create.js";
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

	// 回合看门狗（ADR-0023）：按会话计时（ADR-0030 ①），A 卡住不影响 B
	const turnQueue = createTurnQueue();
	const busy = createBusyHandler({
		activeId: () => state.activeId,
		steer: (id, prompt) => options.engine.sendMessage(id, prompt, () => undefined, { streamingBehavior: "steer" }),
		queue: (id, message) => enqueueWith(state, turnQueue, id, message),
		appendUser: (id, value) =>
			void (state.messages[id] = [
				...(state.messages[id] ?? []),
				appendText(createMessage(nextId("msg"), "user", now()), value),
			]),
		notice: (text, level) => notice(text, level),
		pushSnapshot: () => pushSnapshot(),
	});
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

	// 提示牌 / 审批桥 / 看门狗（ADR-0013 / ADR-0006 / ADR-0023）：装配一次，见 runtime-services.ts
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
		setStats: (stats) => void (state.sessionStats = stats),
		onChanged: pushSnapshot,
	});

	const finishTurn = createTurnFinisher({
		state,
		turns,
		shiftQueued: (conversationId) => dequeueWith(state, turnQueue, conversationId),
		sendNext: (message, conversationId) =>
			setTimeout(() => void apiRef?.sendMessage(message.text, message.attachments, "now", conversationId), 0),
		cancelPending: () => approval.cancelPending(),
		settle: settleWith(state, nextId),
		touchConversation: (conversationId) => touchConversation(conversationId),
		refreshStats: () => void refreshStats(),
		refreshProjects: () => void piRefresher.refresh(true),
		notice: (text, level) => notice(text, level),
		pushSnapshot,
	});

	const api: Runtime = {
		async init() {
			// 装载的「总是允许」规则只写日志：启动信息不该占用对话流（用户明确要求过）
			const ruleCount = await approval.loadRules();
			if (ruleCount > 0) options.onStartupInfo?.(`已装载 ${ruleCount} 条审批规则（这些操作不会再询问）`);
			state.settings = settings ? await settings.load() : defaultSettings();
			await piRefresher.refresh(true);
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

		snapshot() {
			return buildSnapshot(state);
		},

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

			// 只有**同一个会话**在跑才需要判定引导/排队；别的会话各跑各的（ADR-0030 §3）
			if (state.activeId !== null && turns.has(state.activeId)) {
				const handled = await busy(mode, text, resolved.promptText, resolved.images, attachments);
				if (handled) return handled;
			}
			// 会话 id 要在 catch/finally 里也能用（watchdog / 落盘 / 清理都按会话）
			let conversationId: string | null = null;
			try {
				// 没有活动会话才新建（否则复用当前会话 —— 这里曾经写成「每轮都新建」）
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

				// 首条用户消息决定标题
				const isFirstMessage = (state.messages[conv] ?? []).length === 0;
				if (isFirstMessage) {
					touchConversation(conv, { title: text.replace(/\s+/g, " ").trim().slice(0, titleChars) });
				}

				state.messages[conv] = [...(state.messages[conv] ?? []), userMessage, assistantMessage];
				// state.running 只反映当前会话；别的会话并行时不覆盖它（ADR-0030 §2）
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
			// 优先中断当前会话；它没在跑就中断任意一个在飞的（可以切走再停）
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

		pushSnapshot, // 供 provider 等模块「只推帧、不造提示」

		setApprovalMode(mode) {
			approval.setMode(mode);
			state.approvalMode = mode;
			pushSnapshot();
			// 不再推提示：输入区的审批芯片已经显示当前模式（状态类提示不该占对话空间）
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

		async switchConversation(conversationId) {
			const mine = state.conversations.some((conversation) => conversation.id === conversationId);
			const fromPi = piOpener.infoOf(conversationId);
			if (!mine && !fromPi) {
				return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
			}

			// pi 已有的会话：打开它的文件、读回转录（ADR-0021 §2）
			if (!mine && fromPi) {
				if (state.activeId !== conversationId || !state.messages[conversationId]) {
					const messages = await piOpener.open(conversationId, (force) => piRefresher.refresh(force));
					if (messages === null) {
						return { ok: false, error: { code: "session.open_failed", message: `打开会话失败：${conversationId}` } };
					}
					state.messages[conversationId] = messages;
					await models.refresh(conversationId);
					await models.refreshThinking(conversationId);
					state.activeId = conversationId;
					state.files = { root: fromPi.workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
					pushSnapshot();
				}
				return { ok: true };
			}
			if (state.activeId !== conversationId) {
				state.activeId = conversationId;
				pushSnapshot();
			}
			return { ok: true };
		},
	};
	apiRef = api; // 队列排空时要能再调 sendMessage
	return api;
}
