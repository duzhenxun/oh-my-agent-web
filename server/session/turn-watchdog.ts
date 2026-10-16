/**
 * 回合看门狗（ADR-0023）。
 *
 * 为什么必须有：本项目**全局只允许 1 个回合在飞**（ADR-0005）。于是「某个命令卡住」
 * 不是「那一轮慢」，而是**整个应用不能再用** —— 新消息全被 `session.busy` 拒掉。
 * （真事：模型自己去跑了一条会挂住的 bash，回合卡了 7 分钟，界面看起来像死了。）
 *
 * 规则：
 *   1. 回合开始时计时；超时 → 中断该回合 + 给一条明确提示（不是静默杀掉）；
 *   2. **等待用户审批时不计时**（ADR-0006：那是人的时间，不该被机器打断）→ 重新计时；
 *   3. 时间由外部注入（`setTimer`/`clearTimer`），单测可以确定性地触发超时。
 */
/** 给人看的时长格式（提示语用：「20 分钟」/「10 秒」） */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
	return `${Math.round(ms / 60_000)} 分钟`;
}

export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

export type TimerHandle = unknown;

export type TurnWatchdogOptions = {
	timeoutMs?: number;
	/** 超时后调用（通常是 interrupt + notice） */
	onTimeout: (conversationId: string) => void;
	/** 是否正在等人（等审批时不算卡住） */
	isWaitingForUser: () => boolean;
	setTimer?: (callback: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
};

export type TurnWatchdog = {
	start: (conversationId: string) => void;
	/** 回合结束（任何路径）都要调 */
	stop: () => void;
	/** 当前是否在计时（诊断/测试用） */
	armed: () => boolean;
};

export function createTurnWatchdog(options: TurnWatchdogOptions): TurnWatchdog {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let handle: TimerHandle | null = null;
	let conversationId: string | null = null;

	const clear = () => {
		if (handle !== null) clearTimer(handle);
		handle = null;
	};

	const arm = () => {
		clear();
		handle = setTimer(() => {
			handle = null;
			const target = conversationId;
			if (target === null) return;
			if (options.isWaitingForUser()) {
				arm(); // 人在犹豫：继续等，不算卡住
				return;
			}
			conversationId = null;
			options.onTimeout(target);
		}, timeoutMs);
	};

	return {
		start(nextConversationId) {
			conversationId = nextConversationId;
			arm();
		},
		stop() {
			conversationId = null;
			clear();
		},
		armed() {
			return handle !== null;
		},
	};
}

/**
 * runtime 侧的便捷包装：把「超时 → 提示 + 中断」这套接线收在这里，
 * 免得每个调用点都重复写一遍（也让 runtime 守住 400 行护栏）。
 */
export function createRuntimeTurnWatchdog(options: {
	timeoutMs?: number;
	engine: { interrupt: (conversationId: string) => Promise<void> };
	isWaitingForUser: () => boolean;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	/** 注入定时器（单测用；生产走 setTimeout） */
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}): TurnWatchdog {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
	return createTurnWatchdog({
		timeoutMs,
		isWaitingForUser: options.isWaitingForUser,
		...(options.setTimer ? { setTimer: options.setTimer } : {}),
		...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
		onTimeout: (conversationId) => {
			options.notice(`回合超过 ${formatDuration(timeoutMs)}没结束，已自动中断（常见原因：某条命令卡住）`, "warn");
			void options.engine.interrupt(conversationId);
		},
	});
}
