/**
 * ADR-0046：右侧分栏工作区 —— 临时聊天不共用主通道，而是另开一条客户端连接。
 *
 * 为什么需要**第二条连接**：服务端给每个客户端只发一份「你正在看哪个会话」的视图
 * （`server/session/client-view.ts`，ADR-0033）。主聊天用 `agent-web-client` 这个 cookie 里的 id，
 * 同时只有一条 active 会话。右侧要再开一个能独立收发的聊天，就只能在同域下另取一个 clientId：
 * 自己一条 SSE（`/api/events?client=…`）、自己一份快照、自己的 RPC 头（`x-agent-client`）——
 * 服务端一行不用改，主聊天的 active 也不会被顶掉。
 *
 * 纪律：
 *   - **不碰主 store**：这条通道的快照只在本文件的 `state` 里，主界面永远看不到它；
 *   - 一条通道一条会话：临时聊天关闭时把会话也关掉（`close_ephemeral`），不留孤儿；
 *   - 事件解析写成纯函数 `applySideFrame`：帧格式坏了也只是这一帧不动，不炸掉整个面板。
 */
import type { AttachmentRef, Snapshot } from "./types.ts";
import { appendTextToMessage } from "./lib/delta.ts";

export type SideState = {
	snapshot: Snapshot | null;
	/** 最近一次请求失败的原因（只用于面板里那行提示） */
	error: string | null;
	/**
	 * 输入框里正在打的字。
	 * 为什么放在通道状态里、而不是组件自己的 useState：
	 * 「在临时聊天中提问」（对话里选中一段文字）要在**面板还没渲染**的时候就把引用塞进去，
	 * 而且切走标签再切回来不该丢 —— 组件内部状态两头都做不到。
	 */
	draft?: string;
};

const EMPTY: SideState = { snapshot: null, error: null, draft: "" };

/**
 * 一帧服务端消息 → 新的通道状态（纯函数，测试直接喂帧）。
 *
 * 只认这三种：整份快照、流式增量、请求被拒。其余（通知、审批弹窗、其它会话的增量）一律忽略 ——
 * 右侧这块地方只负责「这一条临时聊天」。
 */
function applySideFrame(state: SideState, frame: unknown): SideState {
	if (typeof frame !== "object" || frame === null) return state;
	const raw = frame as Record<string, unknown>;
	if (raw.type === "reply" && raw.ok === false) {
		const error = raw.error as { code?: string; message?: string } | undefined;
		return { ...state, error: error ? `${error.code ?? "error"}: ${error.message ?? ""}` : "请求失败" };
	}
	if (raw.type !== "event") return state;
	if (raw.event === "snapshot" && typeof raw.snapshot === "object" && raw.snapshot !== null) {
		// 保留 ：预填的引用块不能被第一份快照冲掉（快照只代表「会话里有什么」）
		return { ...state, snapshot: raw.snapshot as Snapshot, error: null };
	}
	if (raw.event === "message_delta") {
		const snapshot = state.snapshot;
		const { conversationId, messageId, text } = raw as {
			conversationId?: string;
			messageId?: string;
			text?: string;
		};
		// 不是这条通道在看的那条会话：丢掉（同一个 clientId 不会收别人的，但多标签共用 id 时会）
		if (!snapshot || !messageId || typeof text !== "string") return state;
		if (!conversationId || snapshot.active.conversationId !== conversationId) return state;
		const messages = snapshot.active.messages.map((message) =>
			message.id === messageId ? appendTextToMessage(message, text) : message,
		);
		return { ...state, snapshot: { ...snapshot, active: { ...snapshot.active, messages } } };
	}
	return state;
}

type Listener = (state: SideState) => void;

type SideChannel = {
	readonly id: string;
	get: () => SideState;
	subscribe: (listener: Listener) => () => void;
	/** 开一条临时会话（内存里跑，不落盘） */
	newChat: () => void;
	/** 发一句（附件 / 排队 / 插队跟主对话同一条协议，只是走这条通道的 clientId） */
	send: (text: string, attachments?: AttachmentRef[], mode?: "now" | "queue" | "steer") => void;
	/** 换模型（服务端的模型是引擎级的，跟主对话同源；这边只是换条通道发同一条 RPC） */
	setModel: (modelId: string) => void;
	/** 改输入框里的字（预填引用块也走它） */
	setDraft: (draft: string) => void;
	interrupt: (conversationId: string) => void;
	/** 把临时会话写成一个真正的会话文件（id 不变） */
	persist: (conversationId: string) => void;
	/** 关掉临时会话：消息、引擎句柄、服务端登记一起扔 */
	closeEphemeral: (conversationId: string) => void;
	/** 关标签时用：先关掉那条临时会话，再断开连接（不留孤儿会话 / 孤儿 SSE） */
	shutdown: () => void;
	dispose: () => void;
};

/** 这条通道的请求序号：与服务端 reply 对应，这里只用来满足协议形状 */
let seq = 0;

function createSideChannel(): SideChannel {
	// 前缀 `side-`：服务端日志里一眼能分出「这是右侧分栏开的那条」，不是主窗口
	const id = `side-${crypto.randomUUID()}`;
	let state: SideState = EMPTY;
	const listeners = new Set<Listener>();
	let source: EventSource | null = null;
	let disposed = false;

	const emit = (next: SideState) => {
		if (next === state) return;
		state = next;
		// 记一下「这条会话是自己开的」：主界面据此把它从历史清单里滤掉
		const conversationId = state.snapshot?.active.conversationId;
		if (conversationId) ownedConversations.add(conversationId);
		for (const listener of listeners) listener(state);
	};

	const rpc = (body: Record<string, unknown>) => {
		void (async () => {
			try {
				const response = await fetch("/api/rpc", {
					method: "POST",
					headers: { "content-type": "application/json", "x-agent-client": id },
					body: JSON.stringify({ id: `side-req-${++seq}`, ...body }),
				});
				if (!response.ok) {
					emit({ ...state, error: `请求失败：HTTP ${response.status}` });
					return;
				}
				const payload = (await response.json()) as { frames?: string[] };
				for (const frame of payload.frames ?? []) {
					try {
						emit(applySideFrame(state, JSON.parse(frame)));
					} catch {
						// 单帧坏掉不影响其它帧
					}
				}
			} catch (cause) {
				emit({ ...state, error: cause instanceof Error ? cause.message : String(cause) });
			}
		})();
	};

	const open = () => {
		if (disposed || source) return;
		// `slim=1`：会话清单（侧栏那一大坨）不用给这条通道，它只关心自己那条会话
		const next = new EventSource(`/api/events?client=${encodeURIComponent(id)}&slim=1`);
		source = next;
		next.onmessage = (event) => {
			try {
				emit(applySideFrame(state, JSON.parse(event.data)));
			} catch {
				// 坏帧丢弃
			}
		};
	};

	return {
		id,
		get: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		newChat: () => {
			open();
			rpc({ type: "new_chat", payload: { ephemeral: true } });
		},
		send: (text, attachments, mode) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			open();
			rpc({
				type: "send_message",
				payload: {
					text: trimmed,
					...(attachments && attachments.length > 0 ? { attachments } : {}),
					...(mode && mode !== "now" ? { mode } : {}),
				},
			});
		},
		setModel: (modelId) => rpc({ type: "set_model", payload: { modelId } }),
		setDraft: (draft) => emit({ ...state, draft }),
		interrupt: (conversationId) => rpc({ type: "interrupt", payload: { conversationId } }),
		persist: (conversationId) => rpc({ type: "persist_conversation", payload: { conversationId } }),
		closeEphemeral: (conversationId) => rpc({ type: "close_ephemeral", payload: { conversationId } }),
		shutdown: () => {
			// 先把会话关掉再断连接：反过来的话服务端那条临时会话就成了孤儿，
			// 会一直挂在主界面的会话清单里（直到重启）
			const conversationId = state.snapshot?.active.conversationId;
			if (conversationId) rpc({ type: "close_ephemeral", payload: { conversationId } });
			disposed = true;
			source?.close();
			source = null;
			listeners.clear();
		},
		dispose: () => {
			disposed = true;
			source?.close();
			source = null;
			listeners.clear();
		},
	};
}

/**
 * 面板标签 ↔ 通道的登记表。
 *
 * 放在模块级而不是 React state：通道是「活的连接」，塞进 state 会被 React 当成不可变数据反复比较；
 * 标签自己只需要一个 `id`，渲染时来这里取（同 id 永远同一个通道 →
 * 切标签、重渲染都不会重开 SSE，临时聊天的消息也就不会丢）。
 */
const channels = new Map<string, SideChannel>();
/** 这些会话是分栏临时聊天开的（主界面的会话清单要滤掉，见 `isSideConversation`） */
const ownedConversations = new Set<string>();

export function sideChannelFor(itemId: string): SideChannel {
	let channel = channels.get(itemId);
	if (!channel) {
		channel = createSideChannel();
		channels.set(itemId, channel);
	}
	return channel;
}

export function disposeSideChannel(itemId: string): void {
	const channel = channels.get(itemId);
	if (!channel) return;
	channels.delete(itemId);
	channel.shutdown();
}

/**
 * 这条会话是分栏里的临时聊天吗？
 *
 * 主界面的会话清单要把它滤掉：它是右侧那块地方的窗口，不是「我的会话」——
 * 不滤掉的话，右边随便问一句就会在左边历史里长出一行，关掉标签还不一定认得出来。
 */
export function isSideConversation(conversationId: string): boolean {
	return ownedConversations.has(conversationId);
}
