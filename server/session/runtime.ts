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
import { createMarkerStreamFilter } from "../markers/actions.js";
import { createRuntimeServices } from "./runtime-services.js";
import { createConversationFactory } from "./conversation-create.js";
import { resolveAttachments } from "./attachment-resolve.js";
import { createModelController } from "./model-controller.js";
import { createPiSessionOpener } from "./pi-opener.js";
import { createPiRefresher } from "./pi-refresh.js";
import { settleTurnMarkers } from "./turn-markers.js";
import { applySettingsPatch, defaultSettings, type SettingsStore } from "./settings.js";
import { applyEngineEvent, type TurnEventContext } from "./turn-events.js";
import { makeIdFactory } from "../util/ids.js";
import type {
	AttachmentRef, // 附件引用（ADR-0020 §P3）
	PiProject,
} from "../protocol.js";
import type { EnginePort } from "../engine/port.js";
import { appendText, createMessage } from "../snapshot/messages.js";
import { buildSnapshot, createServerState, emptyRunning } from "../snapshot/state.js";
export type { Result, Runtime, RuntimeEmit } from "./runtime-types.js";
import type { Runtime, RuntimeEmit } from "./runtime-types.js";
export type RuntimeOptions = {
	/** 启动信息（只进日志，不进对话流） */
	onStartupInfo?: (text: string) => void;
	engine: EnginePort;
	/** 审批规则落盘（ADR-0006）：「总是允许这类」跨重启生效 */
	rules: RuleStore;
	/** 回合看门狗超时（ADR-0023）；不给就用默认 20 分钟 */
	turnTimeoutMs?: number;
	/** 附件上传存储（ADR-0020 §P3）：读回上传的文件；不给则附件一律失效 */
	uploadStore?: {
		read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null>;
		pathOf?: (id: string) => string;
	};
	/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（单测用） */
	settings?: SettingsStore;
	/** pi 已有会话的扫描器（ADR-0021 §1）；不给就不显示那一栏（单测用） */
	piSessions?: () => Promise<PiProject[]>;
	/** 两次扫描的最小间隔（默认 10s） */
	piSessionsMinIntervalMs?: number;
	workspace: string;
	/** 当前引擎名（ADR-0016）：会进快照，供界面决定提示语 */
	engineName?: string;
	/** 引擎能力（ADR-0024 §2）；不给就当作全能（单测用） */
	engineCapabilities?: import("../protocol.js").EngineCapabilities;
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
	const settings = options.settings;
	const titleChars = options.titleChars ?? 24;

	const state = createServerState(options.workspace, options.engineName ?? "pi");
	if (options.engineCapabilities) state.engineCapabilities = { ...options.engineCapabilities };
	// 工作区根是已知事实（ADR-0012 的 files 元数据；文件树内容在 M4）
	state.files = { root: options.workspace, treeVersion: 0 };

	// 默认真实运行用全局唯一 id（ADR-0019）；测试注入确定性 id
	const nextId = options.idSeq ?? makeIdFactory();
	let inFlight = false;
	/** 当前回合的流式标记过滤器（ADR-0022） */
	let markerFilter = createMarkerStreamFilter();
	/** 本回合的原始文本（含标记）：建议要在回合结束从这里解析 */
	let rawTurnText = "";

	// 回合看门狗（ADR-0023）：卡住的回合要能自己收场 —— 全局只有 1 路在飞，卡一路等于堵死整个应用
	let currentTurn: { conversationId: string; messageId: string } | null = null;
	/** 回合结束时的落盘任务：sendMessage 必须在返回前等它完成（否则「应答已回、转录还没写」） */
	let finishPromise: Promise<void> | null = null;

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
		onTextDelta: (chunk) => {
			rawTurnText += chunk;
			return markerFilter.push(chunk);
		},
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
		if (turn) {
			settleTurnMarkers({
				state,
				conversationId: turn.conversationId,
				messageId: turn.messageId,
				rawText: rawTurnText,
				nextId,
			});
			// 转录由 SDK 写进会话文件（ADR-0021 §2）—— 我们不再自己追加任何东西
		}

		touchConversation(conversationId);
		void piRefresher.refresh(true);
		if (reason === "interrupted") notice("回合已中断", "info");
		pushSnapshot();
	}

	return {
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
			return inFlight;
		},

		notify(text, level = "info") {
			notice(text, level);
		},

		async sendMessage(text: string, attachments?: AttachmentRef[]) {
			// 附件解析（ADR-0020 §P3）：图片 → base64 视觉注入；非图片 → 只给路径引用
			const resolved = await resolveAttachments(text, attachments, options.uploadStore);
			for (const name of resolved.missing) notice(`附件已失效（可能过期被清理）：${name}`, "warn");
			if (resolved.images.length > 0) notice(`已附加 ${resolved.images.length} 张图片（走视觉注入）`, "info");

			if (inFlight) {
				notice("另一个回合正在跑，先等它结束或点「停止」", "warn");
				return { ok: false, error: { code: "session.busy", message: "已有回合在跑（ADR-0005：全局 1 路）" } };
			}

			inFlight = true;
			try {
				// 没有活动会话才新建（否则复用当前会话 —— 这里曾经写成「每轮都新建」）
				const conversationId = state.activeId ?? (await conversations.create(text));
				// 消息来自扫描/打开（ADR-0021 §2）：新会话此时是空的，无需再读盘
				if (!piOpener.isOpen(conversationId)) {
					const opened = await piOpener.open(conversationId, (force) => piRefresher.refresh(force));
					if (opened === null) throw new Error(`会话打不开：${conversationId}`);
					state.messages[conversationId] = opened;
					await models.refresh(conversationId);
					await models.refreshThinking(conversationId);
				}
				const ts = now();
				const userMessage = appendText(createMessage(nextId("msg"), "user", ts), text);
				const assistantMessage = createMessage(nextId("msg"), "assistant", ts);

				// 首条用户消息决定标题（本地先显示；扫描回来后以会话里的首条消息为准）
				const isFirstMessage = (state.messages[conversationId] ?? []).length === 0;
				if (isFirstMessage) {
					touchConversation(conversationId, { title: text.replace(/\s+/g, " ").trim().slice(0, titleChars) });
				}

				state.messages[conversationId] = [...(state.messages[conversationId] ?? []), userMessage, assistantMessage];
				state.running = { status: "streaming", turnStartedAt: ts, streamingText: "", activeTool: null };
				state.actions = []; // 新一轮开始：上一轮的建议作废（ADR-0022）
				markerFilter = createMarkerStreamFilter();
				rawTurnText = "";
				watchdog.start(conversationId);
				currentTurn = { conversationId, messageId: assistantMessage.id };
				touchConversation(conversationId);

				pushSnapshot();

				await options.engine.sendMessage(
					conversationId,
					resolved.promptText,
					(event) => {
						applyEngineEvent(turnContext, { conversationId, messageId: assistantMessage.id, event });
					},
					resolved.images.length > 0 ? { images: resolved.images } : undefined,
				);
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`回合执行失败：${message}`, "error");
				state.running = { ...emptyRunning(), status: "error" };
				currentTurn = null;
				pushSnapshot();
				return { ok: false, error: { code: "session.turn_failed", message } };
			} finally {
				watchdog.stop();
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

		setModel: (modelId) => models.switchTo(state.activeId, modelId),

		setThinkingLevel: (level) => models.setThinking(state.activeId, level),

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
}
