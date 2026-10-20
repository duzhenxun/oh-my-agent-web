/**
 * 排队中的后续消息（ADR-0030 的"排队"部分）。
 *
 * 为什么用我们自己的队列而不是 pi 的 followUp：pi 的 followUp 事件不会回到我们的回合生命周期，
 * 助手输出就不会出现在界面上。走自己的队列 → 回合结束后照常走 sendMessage，
 * 落盘、看门狗、流式显示全部不变。
 *
 * 每条排队项都有**自己的 id**：界面上的 × 要能真取消它（只按文本匹配会误伤重复内容）。
 */
import type { AttachmentRef, SendMode } from "../protocol.js";

export type QueuedMessage = { id: string; conversationId: string; text: string; attachments?: AttachmentRef[] };
/** 给界面看的形状（不含附件本体） */
export type QueuedView = { id: string; conversationId: string; text: string };

export function createTurnQueue() {
	const entries: QueuedMessage[] = [];
	return {
		push(entry: QueuedMessage): QueuedView[] {
			entries.push(entry);
			return toViews(entries);
		},
		/** 取走某会话的队首（没有就返回 null） */
		shift(conversationId: string): QueuedMessage | null {
			const index = entries.findIndex((entry) => entry.conversationId === conversationId);
			if (index < 0) return null;
			return entries.splice(index, 1)[0] ?? null;
		},
		/** 取消一条（按 id）；返回是否真的删掉了 */
		remove(id: string): boolean {
			const index = entries.findIndex((entry) => entry.id === id);
			if (index < 0) return false;
			entries.splice(index, 1);
			return true;
		},
		/** 删掉某个会话的全部排队项（会话被删时用） */
		removeConversation(conversationId: string): void {
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				if (entries[i]?.conversationId === conversationId) entries.splice(i, 1);
			}
		},
		views: (): QueuedView[] => toViews(entries),
	};
}

function toViews(entries: QueuedMessage[]): QueuedView[] {
	return entries.map(({ id, conversationId, text }) => ({ id, conversationId, text }));
}

/**
 * 「回合进行中又发来一条消息」的处理（从 runtime 抽出来：400 行护栏）。
 * 返回 null = 调用方继续走正常回合；返回 Result = 已经处理完（引导 / 排队 / 拒绝）。
 */
export type BusyResult = { ok: true } | { ok: false; error: { code: string; message: string } } | null;

export function createBusyHandler(deps: {
	activeId: () => string | null;
	steer: (conversationId: string, promptText: string) => Promise<unknown>;
	queue: (conversationId: string, text: string, attachments?: AttachmentRef[]) => number;
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
			const depth = deps.queue(conversationId, text, attachments);
			deps.notice(`已排队（第 ${depth} 条）：这一轮结束后自动发送`, "info");
			deps.pushSnapshot();
			return { ok: true };
		}
		if (mode === "steer") {
			await deps.steer(conversationId, promptText);
			deps.appendUser(conversationId, text);
			deps.notice("已引导：插进当前这一轮", "info");
			deps.pushSnapshot();
			return { ok: true };
		}
		deps.notice("另一个回合还在跑，先等它结束或点「停止」", "warn");
		return { ok: false, error: { code: "session.busy", message: "同一会话已有回合在跑" } };
	};
}

/** 队列 + 快照同步（runtime 里只留三个一行调用） */
export function createQueueController(options: {
	turnQueue: ReturnType<typeof createTurnQueue>;
	state: { queued: QueuedView[] };
	nextId: (prefix: string) => string;
	onChanged: () => void;
}) {
	const sync = () => {
		options.state.queued = options.turnQueue.views();
		options.onChanged();
	};
	return {
		push(conversationId: string, text: string, attachments?: AttachmentRef[]): number {
			const views = options.turnQueue.push({
				id: options.nextId("q"),
				conversationId,
				text,
				...(attachments ? { attachments } : {}),
			});
			sync();
			return views.filter((view) => view.conversationId === conversationId).length;
		},
		shift(conversationId: string) {
			const next = options.turnQueue.shift(conversationId);
			sync();
			return next;
		},
		cancel(queueId: string): boolean {
			const removed = options.turnQueue.remove(queueId);
			sync();
			return removed;
		},
	};
}

/** runtime 的队列/忙碌处理装配（一行调用，runtime 守 400 行） */
export function createTurnPlumbing(options: {
	state: { activeId: string | null; queued: QueuedView[] };
	engine: {
		sendMessage: (
			id: string,
			prompt: string,
			onEvent: () => void,
			opts: { streamingBehavior: "steer" },
		) => Promise<void>;
	};
	nextId: (prefix: string) => string;
	appendUser: (conversationId: string, text: string) => void;
	notice: (text: string, level: "info" | "warn") => void;
	pushSnapshot: () => void;
}) {
	const queue = createQueueController({
		turnQueue: createTurnQueue(),
		state: options.state,
		nextId: options.nextId,
		onChanged: options.pushSnapshot,
	});
	const busy = createBusyHandler({
		activeId: () => options.state.activeId,
		steer: (id, prompt) => options.engine.sendMessage(id, prompt, () => {}, { streamingBehavior: "steer" }),
		queue: (id, text, attachments) => queue.push(id, text, attachments),
		appendUser: options.appendUser,
		notice: options.notice,
		pushSnapshot: options.pushSnapshot,
	});
	return { queue, busy };
}

/** 取消一条排队消息的对外动作（runtime 里只留一行） */
export function cancelQueuedWith(
	queue: { cancel: (queueId: string) => boolean },
	queueId: string,
	notice: (text: string, level: "info" | "warn") => void,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
	if (!queue.cancel(queueId))
		return { ok: false, error: { code: "queue.not_found", message: "这条排队消息已经不在了" } };
	notice("已取消排队", "info");
	return { ok: true };
}
