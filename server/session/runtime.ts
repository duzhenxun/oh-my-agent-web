/**
 * 会话运行时（宿主侧）：把引擎事件翻译成 UI 状态 / 协议事件（ADR-0003、ADR-0004、ADR-0005）。
 *
 * M1 版是**内存态**：会话只活在进程里（落盘是 M2 的事），但已经遵守 M2 之后也不会变的规则：
 *   - 全局同时只允许 **1 路在飞回合**（ADR-0005）：再发就拒绝 + 提示，不排队；
 *   - 危险操作走审批三态（ADR-0006）：允许一次 / 总是允许这类 / 拒绝；
 *   - 快照只在**结构性变化**时推：正文靠 message_delta 增量，避免每字重推全量（ADR-0004 §3）；
 *   - notice 同码去重（ADR-0013）。
 */
import type { ApprovalDecision, Notice, ProtocolError, ServerEvent, Snapshot, UiMessage } from "../protocol.js";
import type { ApprovalRequest, EngineEvent, EnginePort } from "../engine/port.js";
import { appendError, appendText, createMessage, finishTool, startTool } from "../snapshot/messages.js";
import {
	buildSnapshot,
	createConversation,
	createServerState,
	emptyRunning,
	type ServerState,
} from "../snapshot/state.js";

export type RuntimeEmit = {
	snapshot(snapshot: Snapshot): void;
	event(event: ServerEvent): void;
};

export type Result = { ok: true } | { ok: false; error: ProtocolError };

export type Runtime = {
	snapshot(): Snapshot;
	state(): ServerState;
	sendMessage(text: string): Promise<Result>;
	interrupt(): Promise<Result>;
	approve(requestId: string, decision: ApprovalDecision): Result;
	isBusy(): boolean;
};

export type RuntimeOptions = {
	engine: EnginePort;
	workspace: string;
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
	const noticeDedupeMs = options.noticeDedupeMs ?? 5000;
	const maxNotices = options.maxNotices ?? 20;
	const titleChars = options.titleChars ?? 24;

	const state = createServerState(options.workspace);
	const alwaysAllowed = new Set<string>();
	const recentNotices = new Map<string, number>();

	let seq = 0;
	const nextId = options.idSeq ?? ((prefix: string) => `${prefix}-${++seq}`);
	let inFlight = false;
	let pending: { requestId: string; scopeKey: string; resolve: (decision: ApprovalDecision) => void } | null = null;

	const pushSnapshot = () => options.emit.snapshot(buildSnapshot(state));

	function notice(text: string, level: Notice["level"] = "info"): void {
		const key = `${level}:${text}`;
		const ts = now();
		const last = recentNotices.get(key);
		if (last !== undefined && ts - last < noticeDedupeMs) return;
		recentNotices.set(key, ts);

		const entry: Notice = { id: nextId("notice"), level, text, ts };
		state.notices = [...state.notices, entry].slice(-maxNotices);
		options.emit.event({ type: "event", event: "notice", notice: entry });
		pushSnapshot();
	}

	async function handleApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		const scopeKey = `${request.toolName}|${request.scopeHint}`;
		if (alwaysAllowed.has(scopeKey)) return "always";

		const requestId = nextId("appr");
		state.pendingApproval = {
			requestId,
			toolName: request.toolName,
			argsSummary: request.argsSummary,
			riskNote: request.riskNote,
			scopeHint: request.scopeHint,
		};
		state.running.status = "awaiting_approval";
		pushSnapshot();

		return new Promise<ApprovalDecision>((resolve) => {
			pending = { requestId, scopeKey, resolve };
		});
	}
	options.engine.setApprovalHandler(handleApproval);

	async function ensureConversation(seedText: string): Promise<string> {
		if (state.activeId) return state.activeId;
		const id = nextId("conv");
		const title = firstLine(seedText).slice(0, titleChars) || "新对话";
		state.conversations = [
			...state.conversations,
			createConversation({ id, title, workspace: state.workspace, now: now() }),
		];
		state.messages[id] = [];
		// 同步置位 activeId：单写入者假设（ADR-0005）靠它 —— interrupt 与审批在 createSession 完成前
		// 就得看得到「当前会话」，否则会出现「回合在跑但没有会话」的窗口。
		state.activeId = id;
		try {
			await options.engine.createSession({ sessionId: id, workspace: state.workspace });
		} catch (error) {
			state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
			delete state.messages[id];
			state.activeId = null;
			throw error;
		}
		pushSnapshot();
		return id;
	}

	function updateConversationMeta(conversationId: string): void {
		state.conversations = state.conversations.map((conversation) =>
			conversation.id === conversationId
				? {
						...conversation,
						updatedAt: now(),
						messageCount: state.messages[conversationId]?.length ?? 0,
					}
				: conversation,
		);
	}

	function patchMessage(conversationId: string, messageId: string, patch: (message: UiMessage) => UiMessage): void {
		const list = state.messages[conversationId] ?? [];
		state.messages[conversationId] = list.map((message) => (message.id === messageId ? patch(message) : message));
	}

	function handleEngineEvent(conversationId: string, messageId: string, event: EngineEvent): void {
		switch (event.type) {
			case "text_delta": {
				patchMessage(conversationId, messageId, (message) => appendText(message, event.text));
				state.running.streamingText += event.text;
				// 正文只走增量事件（ADR-0004 §3）：快照等下一次结构性变化再推
				options.emit.event({
					type: "event",
					event: "message_delta",
					conversationId,
					messageId,
					text: event.text,
				});
				return;
			}
			case "tool_start": {
				patchMessage(conversationId, messageId, (message) =>
					startTool(message, {
						toolCallId: event.toolCallId,
						name: event.name,
						argsSummary: event.argsSummary,
						startedAt: now(),
					}),
				);
				state.running.activeTool = { name: event.name, argsSummary: event.argsSummary, startedAt: now() };
				pushSnapshot();
				return;
			}
			case "tool_end": {
				patchMessage(conversationId, messageId, (message) =>
					finishTool(message, {
						toolCallId: event.toolCallId,
						status: event.status,
						output: event.output,
						endedAt: now(),
						...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
					}),
				);
				state.running.activeTool = null;
				pushSnapshot();
				return;
			}
			case "error": {
				patchMessage(conversationId, messageId, (message) => appendError(message, event.code, event.message));
				state.running.status = "error";
				notice(`${event.code}: ${event.message}`, "error");
				pushSnapshot();
				return;
			}
			case "turn_end": {
				finishTurn(conversationId, event.reason);
				return;
			}
		}
	}

	function finishTurn(conversationId: string, reason: "done" | "interrupted" | "error"): void {
		const keepError = reason === "error" || state.running.status === "error";
		state.running = { ...emptyRunning(), status: keepError ? "error" : "idle" };
		state.pendingApproval = null;
		pending = null;
		updateConversationMeta(conversationId);
		if (reason === "interrupted") notice("回合已中断", "info");
		pushSnapshot();
	}

	return {
		snapshot() {
			return buildSnapshot(state);
		},

		state() {
			return state;
		},

		isBusy() {
			return inFlight;
		},

		async sendMessage(text: string) {
			if (inFlight) {
				notice("另一个回合正在跑，先等它结束或点「停止」", "warn");
				return { ok: false, error: { code: "session.busy", message: "已有回合在跑（ADR-0005：全局 1 路）" } };
			}

			inFlight = true;
			try {
				const conversationId = await ensureConversation(text);
				const ts = now();
				const userMessage = appendText(createMessage(nextId("msg"), "user", ts), text);
				const assistantMessage = createMessage(nextId("msg"), "assistant", ts);
				state.messages[conversationId] = [...(state.messages[conversationId] ?? []), userMessage, assistantMessage];
				state.running = { status: "streaming", turnStartedAt: ts, streamingText: "", activeTool: null };
				updateConversationMeta(conversationId);
				pushSnapshot();

				await options.engine.sendMessage(conversationId, text, (event) =>
					handleEngineEvent(conversationId, assistantMessage.id, event),
				);
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice(`回合执行失败：${message}`, "error");
				state.running = { ...emptyRunning(), status: "error" };
				pushSnapshot();
				return { ok: false, error: { code: "session.turn_failed", message } };
			} finally {
				inFlight = false;
			}
		},

		async interrupt() {
			if (!inFlight || !state.activeId) {
				return { ok: false, error: { code: "session.idle", message: "当前没有在跑的回合" } };
			}
			await options.engine.interrupt(state.activeId);
			return { ok: true };
		},

		approve(requestId, decision) {
			if (!pending || pending.requestId !== requestId) {
				return { ok: false, error: { code: "approval.unknown_request", message: "没有待处理的审批请求" } };
			}
			if (decision === "always") {
				alwaysAllowed.add(pending.scopeKey);
				notice("已记住：以后这类操作不再询问（M1 只在本次运行内有效）", "info");
			}
			const resolveDecision = pending.resolve;
			pending = null;
			state.pendingApproval = null;
			if (state.running.status === "awaiting_approval") state.running.status = "streaming";
			pushSnapshot();
			resolveDecision(decision);
			return { ok: true };
		},
	};
}

function firstLine(text: string): string {
	return (text.split("\n")[0] ?? "").trim();
}
