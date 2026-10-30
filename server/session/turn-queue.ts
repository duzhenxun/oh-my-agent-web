/**
 * 排队中的后续消息（ADR-0030 的"排队"部分）。
 *
 * 为什么用我们自己的队列而不是 pi 的 followUp：pi 的 followUp 事件不会回到我们的回合生命周期，
 * 助手输出就不会出现在界面上。走自己的队列 → 回合结束后照常走 sendMessage，
 * 落盘、看门狗、流式显示全部不变。
 *
 * 每条排队项都有**自己的 id**：界面上的 × 要能真取消它（只按文本匹配会误伤重复内容）。
 */
import type { AttachmentRef, QueuedMode, SendMode } from "../protocol.js";

export type QueuedMessage = {
	id: string;
	conversationId: string;
	text: string;
	/** queue = 等这一轮结束再发；steer = 插队（到 step 边界注入，注入前可取消） */
	mode: QueuedMode;
	/** 入队时刻：插队有一个**最小撤回窗口**（见 STEER_MIN_HOLD_MS），要靠它算 */
	queuedAt?: number;
	attachments?: AttachmentRef[];
};
/** 给界面看的形状（不含附件本体） */
export type QueuedView = { id: string; conversationId: string; text: string; mode: QueuedMode };

function createTurnQueue() {
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
		/** 取消一条（按 id）；返回被删掉的那条（没有就 null）—— 调用方靠 mode 决定提示语 */
		remove(id: string): QueuedMessage | null {
			const index = entries.findIndex((entry) => entry.id === id);
			if (index < 0) return null;
			return entries.splice(index, 1)[0] ?? null;
		},
		/** 看一眼某会话队首的插队项（不取走） */
		peekSteer(conversationId: string): QueuedMessage | null {
			return entries.find((entry) => entry.conversationId === conversationId && entry.mode === "steer") ?? null;
		},
		/**
		 * 取走某会话队首的「插队」那一项（没有就 null）。
		 *
		 * 只在**注入时机到了**才调：插队先挂在队列里 → 界面上就是一条可撤回的待发行 →
		 * 到 step 边界（或兑底超时）才用 streamingBehavior:"steer" 真正插进去。
		 */
		takeSteer(conversationId: string): QueuedMessage | null {
			const index = entries.findIndex((entry) => entry.conversationId === conversationId && entry.mode === "steer");
			if (index < 0) return null;
			return entries.splice(index, 1)[0] ?? null;
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
	return entries.map(({ id, conversationId, text, mode }) => ({ id, conversationId, text, mode }));
}

/**
 * 「回合进行中又发来一条消息」的处理（从 runtime 抽出来：400 行护栏）。
 * 返回 null = 调用方继续走正常回合；返回 Result = 已经处理完（插队 / 排队 / 拒绝）。
 */
type BusyResult = { ok: true } | { ok: false; error: { code: string; message: string } } | null;

export function createBusyHandler(deps: {
	/** 排队 / 插队落在**这条消息真正要去**的那个会话上（不是全局 activeId，见 turn-send 的说明） */
	queue: (conversationId: string, text: string, attachments: AttachmentRef[] | undefined, mode: QueuedMode) => number;
	/** steer = true：这条是「插队」插进来的（界面要标一下） */
	appendUser: (conversationId: string, text: string, steer?: boolean) => void;
	notice: (text: string, level: "info" | "warn") => void;
	pushSnapshot: () => void;
	/**
	 * 当前引擎能不能真插队（ADR-0043）。不传按「能」算（老调用方兼容）。
	 * 用**函数**而不是布尔值：引擎可以在会话中途被切换，能力也跟着变。
	 */
	supportsSteer?: () => boolean;
}) {
	return async (
		mode: SendMode,
		text: string,
		promptText: string,
		_images: unknown,
		/** 这条消息要去的会话（调用方已按客户端视图算好；不会为 null） */
		conversationId: string,
		attachments?: AttachmentRef[],
	): Promise<BusyResult> => {
		if (mode === "queue") {
			const depth = deps.queue(conversationId, text, attachments, "queue");
			deps.notice(`已排队（第 ${depth} 条）：这一轮结束后自动发送`, "info");
			deps.pushSnapshot();
			return { ok: true };
		}
		if (mode === "steer") {
			// 引擎没有「插进正在跑的这一轮」这个语义时（codex / dsh / opencode 的底层协议都没有），
			// 硬发第二条 `sendMessage` 会覆盖引擎自己的活跃回合：codex 是第一条回合的 promise 永不 resolve
			// （该会话永久 busy），dsh/opencode 是整轮输出被路由到只收 error 的监听器（ADR-0043）。
			// 所以在这里就降级成排队，并且**说出来**，不要让它变一个看不见的坑。
			const steerable = deps.supportsSteer?.() ?? true;
			const depth = deps.queue(conversationId, text, attachments, steerable ? "steer" : "queue");
			deps.notice(
				steerable
					? "已插队：等当前这一步结束插进去（还没插进去，可以撤回）"
					: `这个引擎不支持插队，已改为排队（第 ${depth} 条）：这一轮结束后自动发送`,
				steerable ? "info" : "warn",
			);
			deps.pushSnapshot();
			return { ok: true };
		}
		deps.notice("另一个回合还在跑，先等它结束或点「停止」", "warn");
		return { ok: false, error: { code: "session.busy", message: "同一会话已有回合在跑" } };
	};
}

/** 队列 + 快照同步（runtime 里只留三个一行调用） */
function createQueueController(options: {
	turnQueue: ReturnType<typeof createTurnQueue>;
	state: { queued: QueuedView[] };
	nextId: (prefix: string) => string;
	/** 入队时间（最小撤回窗口要用）；不给就用 Date.now */
	now?: () => number;
	onChanged: () => void;
}) {
	const sync = () => {
		options.state.queued = options.turnQueue.views();
		options.onChanged();
	};
	return {
		push(conversationId: string, text: string, attachments: AttachmentRef[] | undefined, mode: QueuedMode): number {
			const views = options.turnQueue.push({
				id: options.nextId("q"),
				conversationId,
				text,
				mode,
				queuedAt: options.now?.() ?? Date.now(),
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
		/** 看一眼挂着的插队（不取走）：判断最小撤回窗口用 */
		peekSteer(conversationId: string): QueuedMessage | null {
			return options.turnQueue.peekSteer(conversationId);
		},
		/** 取走一条挂着的插队（注入时才调） */
		takeSteer(conversationId: string) {
			const next = options.turnQueue.takeSteer(conversationId);
			if (next) sync();
			return next;
		},
		/** 这个会话还挂着插队吗（一次只插一条，插完看还有没有下一条） */
		hasSteer(conversationId: string): boolean {
			return options.turnQueue.views().some((item) => item.conversationId === conversationId && item.mode === "steer");
		},
		/** 取消一条待发（排队或插队都行）；返回被删掉那条的 kind，界面靠它说准话 */
		cancel(queueId: string): QueuedMode | null {
			const removed = options.turnQueue.remove(queueId);
			if (!removed) return null;
			sync();
			return removed.mode;
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
			/** 宽成 unknown：注入这一轮的错误也要能接住（见 flushSteer） */
			onEvent: (event: unknown) => void,
			opts: { streamingBehavior: "steer" },
		) => Promise<void>;
	};
	nextId: (prefix: string) => string;
	/** steer = true：这条是「插队」插进来的（界面要标一下） */
	appendUser: (conversationId: string, text: string, steer?: boolean) => void;
	notice: (text: string, level: "info" | "warn") => void;
	pushSnapshot: () => void;
	/**
	 * 这个会话现在真的还有回合在跑吗？注入前先问一句：
	 * 兜底计时器可能在回合刚结束那一刻醒（那时再 steer 就白丢了）—— 不注入、把条目留在队列里，
	 * 交给收尾的 queue.shift 把它当下一轮发出去。
	 */
	isTurnRunning?: (conversationId: string) => boolean;
	/** 当前时间（最小撤回窗口用；测试可注入） */
	now?: () => number;
	/**
	 * 当前引擎能不能真插队（ADR-0043）。不传按「能」算；
	 * 用函数是因为引擎可以在会话中途被切换。
	 */
	supportsSteer?: () => boolean;
}) {
	const now = options.now ?? (() => Date.now());
	const queue = createQueueController({
		turnQueue: createTurnQueue(),
		state: options.state,
		nextId: options.nextId,
		now,
		onChanged: options.pushSnapshot,
	});
	/** 每个会话一个兑底计时器：插队挂着太久就不等边界了 */
	const steerTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * 把挂着的「插队」真正插进当前回合。
	 *
	 * 调用时机只有三种（都是宿主的判断，不靠用户再点一次）：
	 *   1. 当前回合到了 step 边界（一条工具调用 / 一次模型调用收尾）—— 这也正是引擎自己插队的时机；
	 *   2. 兑底超时（记在 STEER_HOLD_MS）—— 免得遇到长时间无边界的一轮，插队默默退化成排队；
	 *   3. 这一轮已经结束（收尾时排空队列会把它当成下一轮发，不会丢）。
	 */
	const flushSteer = (conversationId: string): void => {
		clearSteerTimer(conversationId);
		// 回合已经结束了：不注入（否则消息落了盘、模型却收不到）—— 留给收尾排空当下一轮发
		if (options.isTurnRunning && !options.isTurnRunning(conversationId)) return;
		// 最小撤回窗口：模型这边 step 边界来得很快（常常一秒内），那 `× 取消插队` 基本来不及点。
		// 界面上一按就是"还没插进去、可以撤回"，那就得真的给得出这段时间 —— 到点再来一次。
		const pending = queue.peekSteer(conversationId);
		if (pending?.queuedAt !== undefined && now() - pending.queuedAt < STEER_MIN_HOLD_MS) {
			scheduleSteerFlush(conversationId);
			return;
		}
		const held = queue.takeSteer(conversationId);
		if (!held) return;
		/**
		 * 兜底：队列里真的还挂着 steer 条目时再看一次能力（ADR-0043）。
		 * 两种情形会走到这里：能力字段是后加的（老数据里还留着 steer 项）、
		 * 或者用户在这一轮中途把引擎切成了不支持插队的那个。
		 * 一律改成排队等下一轮，**绝不**第二次调 sendMessage。
		 */
		if (!(options.supportsSteer?.() ?? true)) {
			queue.push(held.conversationId, held.text, held.attachments, "queue");
			options.notice("这个引擎不支持插队，已改为排队：这一轮结束后自动发送", "warn");
			return;
		}
		// 先进消息流再注入：界面与对话记录的顺序与旧行为一致（插队就在当前这一轮里）
		options.appendUser(held.conversationId, held.text, true);
		options.pushSnapshot();
		/**
		 * 注入失败必须说出来。
		 *
		 * 这个消息已经落在对话记录里了（上面 appendUser）—— 如果注入静默失败，用户看到的是
		 * 「我插队了」，实际模型**从没收到过这句话**，而界面上又没有任何痕迹可以追。
		 * 以前是 `.catch(() => undefined)` + 空 onEvent，两个失败通道全被吃掉；
		 * 引擎的 error 也是走 onEvent 报的（pi-sdk 不抛异常），所以那个也得接。
		 *
		 * 注意：注入这一轮的**输出**仍然由原来那一轮的 onEvent 投影到界面（引擎的会话事件
		 * 是广播给所有订阅者的），这里只负责收集错误，不重复投影。
		 */
		const failures: string[] = [];
		void options.engine
			.sendMessage(
				held.conversationId,
				held.text,
				(event) => {
					const item = event as { type?: string; message?: unknown } | null | undefined;
					if (item?.type !== "error") return;
					failures.push(typeof item.message === "string" ? item.message : "未知错误");
				},
				{ streamingBehavior: "steer" },
			)
			.then(() => {
				if (failures.length === 0) return;
				options.notice(`插队没成功（${failures[0]}）：这条消息还在对话里，可以再发一次`, "warn");
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				options.notice(`插队失败：${message}；这条消息还在对话里，可以再发一次`, "warn");
			});
		options.notice("已插队：插进当前这一轮", "info");
		// 还挂着别的话继续等下一个边界（一次只插一条，和队列语义一致）
		if (queue.hasSteer(conversationId)) scheduleSteerFlush(conversationId);
	};

	const clearSteerTimer = (conversationId: string): void => {
		const timer = steerTimers.get(conversationId);
		if (!timer) return;
		clearTimeout(timer);
		steerTimers.delete(conversationId);
	};

	/** 兑底：挂着超过 STEER_HOLD_MS 还没遇到 step 边界就直接插（不退化成排队） */
	const scheduleSteerFlush = (conversationId: string): void => {
		if (steerTimers.has(conversationId)) return;
		const timer = setTimeout(() => {
			steerTimers.delete(conversationId);
			flushSteer(conversationId);
		}, STEER_HOLD_MS);
		timer.unref?.();
		steerTimers.set(conversationId, timer);
	};

	const busy = createBusyHandler({
		queue: (id, text, attachments, mode) => {
			const depth = queue.push(id, text, attachments, mode);
			if (mode === "steer") scheduleSteerFlush(id);
			return depth;
		},
		appendUser: options.appendUser,
		notice: options.notice,
		pushSnapshot: options.pushSnapshot,
		supportsSteer: options.supportsSteer,
	});
	return { queue, busy, flushSteer };
}

/** 插队挂在宿主上的最长时长：超过它就不再等 step 边界（否则插队会退化成排队） */
export const STEER_HOLD_MS = 3000;

/**
 * 插队的**最小撤回窗口**：这段时间内即使 step 边界已经到了也不注入。
 *
 * 为什么要有：模型那边一次工具调用/一次模型收尾就是一次边界，常常几百毫秒就来一个 ——
 * 于是"插队"卡片刚出现就被注入，界面上的 `× 取消插队` 根本来不及点（点了也没东西可取消）。
 * 既然提示语承诺"还没插进去、可以撤回"，就得给得出这段真实的时间。
 * 代价是插队最多晚 1.2 秒生效，换来一个可用的撤回按钮。
 */
export const STEER_MIN_HOLD_MS = 1200;

/** 取消一条待发消息的对外动作（runtime 里只留一行） */
export function cancelQueuedWith(
	queue: { cancel: (queueId: string) => QueuedMode | null },
	queueId: string,
	notice: (text: string, level: "info" | "warn") => void,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
	const kind = queue.cancel(queueId);
	if (!kind)
		return { ok: false, error: { code: "queue.not_found", message: "这条待发消息已经不在了（可能已插进去/已发出）" } };
	notice(kind === "steer" ? "已取消插队：不会插进去了" : "已取消排队", "info");
	return { ok: true };
}
