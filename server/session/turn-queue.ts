/**
 * 排队中的后续消息（ADR-0030 的"排队"部分）。
 *
 * 为什么用我们自己的队列而不是 pi 的 followUp：pi 的 followUp 事件不会回到我们的回合生命周期，
 * 助手输出就不会出现在界面上。走自己的队列 → 回合结束后照常走 sendMessage，
 * 落盘、看门狗、流式显示全部不变。
 */
import type { AttachmentRef, SendMode } from "../protocol.js";

export type QueuedMessage = { text: string; attachments?: AttachmentRef[] };

export function createTurnQueue() {
	const pending = new Map<string, QueuedMessage[]>();
	return {
		push(conversationId: string, message: QueuedMessage): number {
			const list = pending.get(conversationId) ?? [];
			list.push(message);
			pending.set(conversationId, list);
			return list.length;
		},
		/** 取走队首（没有就返回 null），并清理空队列 */
		shift(conversationId: string): QueuedMessage | null {
			const list = pending.get(conversationId);
			if (!list || list.length === 0) return null;
			const next = list.shift() ?? null;
			if (list.length === 0) pending.delete(conversationId);
			return next;
		},
		size(conversationId: string): number {
			return pending.get(conversationId)?.length ?? 0;
		},
	};
}

/**
 * 「回合进行中又发来一条消息」的处理（从 runtime 抽出来：400 行护栏）。
 * 返回 null = 调用方继续走正常回合；返回 Result = 已经处理完（引导 / 排队 / 拒绝）。
 */
export type BusyResult = { ok: true } | { ok: false; error: { code: string; message: string } } | null;

/** 绑定好依赖后的「回合进行中又发来消息」处理器（runtime 只留一行调用） */
export function createBusyHandler(deps: {
	activeId: () => string | null;
	steer: (conversationId: string, promptText: string) => Promise<unknown>;
	queue: (conversationId: string, message: QueuedMessage) => number;
	appendUser: (conversationId: string, text: string) => void;
	notice: (text: string, level: "info" | "warn") => void;
	pushSnapshot: () => void;
}) {
	return async (
		mode: SendMode,
		text: string,
		promptText: string,
		_images: unknown,
		attachments?: AttachmentRef[],
	): Promise<BusyResult> => {
		const conversationId = deps.activeId();
		if (!conversationId) return { ok: false, error: { code: "session.none", message: "先打开一个会话" } };
		if (mode === "queue") {
			const depth = deps.queue(conversationId, { text, ...(attachments ? { attachments } : {}) });
			deps.notice(`已排队（第 ${depth} 条）：这一轮结束后自动发送`, "info");
			return { ok: true };
		}
		if (mode === "steer") {
			await deps.steer(conversationId, promptText);
			deps.appendUser(conversationId, text);
			deps.notice("已引导：插进当前这一轮", "info");
			deps.pushSnapshot();
			return { ok: true };
		}
		deps.notice("另一个回合正在跑，先等它结束或点「停止」", "warn");
		return { ok: false, error: { code: "session.busy", message: "已有回合在跑（ADR-0005：全局 1 路）" } };
	};
}
