/**
 * 运行期的三件基础设施 —— 从 runtime 抽出（400 行护栏）。
 *
 * 它们彼此相关、且都是「装配一次、到处用」的东西：
 *   1. **提示牌**（notice）：分级 + 同码去重 + 条数上限（ADR-0013）；
 *   2. **审批桥**（approval）：危险操作等一次点击（ADR-0006）；
 *   3. **回合看门狗**（watchdog）：卡住的回合自动收场（ADR-0023）。
 *
 * 抽出来还有个好处：runtime 只描述「会话怎么跑」，不再夹着三段装配代码。
 */
import type { EnginePort } from "../engine/port.js";
import type { RuleStore } from "../approval/rules.js";
import type { ApprovalMode, Notice, PendingApproval } from "../protocol.js";
import { createApprovalBridge, type ApprovalBridge } from "./approval-bridge.js";
import { createNoticeSink } from "./notices.js";
import { createRuntimeTurnWatchdog, type TurnWatchdog } from "./turn-watchdog.js";

type RuntimeServices = {
	/**
	 * 推一条界面提示（去重由提示牌负责）。
	 * `conversationId` 有值时，这条提示只在「看那个会话」的界面上显示。
	 */
	notice: (text: string, level?: Notice["level"], key?: string, conversationId?: string) => void;
	approval: ApprovalBridge;
	watchdog: TurnWatchdog;
};

type RuntimeServicesOptions = {
	/** runtime 的选项（只管用其中几个） */
	options: {
		engine: EnginePort;
		rules: RuleStore;
		noticeDedupeMs?: number;
		maxNotices?: number;
		turnTimeoutMs?: number;
	};
	now: () => number;
	nextId: (prefix: string) => string;
	/** 提示真正推给界面时调用（runtime 负责塞进 state.notices 并发事件） */
	onNotice: (notice: Notice) => void;
	/** 审批弹窗状态变化（null = 清空） */
	onPending: (pending: PendingApproval | null) => void;
	isWaitingForUser: () => boolean;
	/** 某个会话当前的审批模式（模式的事实源在 state 上，桥只读） */
	modeOf: (conversationId: string | null) => ApprovalMode;
};

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
	const sink = createNoticeSink({
		now: options.now,
		nextId: options.nextId,
		dedupeMs: options.options.noticeDedupeMs,
		max: options.options.maxNotices,
		onNotice: options.onNotice,
	});
	/**
	 * 推一条提示（`key` 相同就原地替换；`conversationId` 有值就只给「看那个会话」的界面）。
	 *
	 * ⚠️ 四个参数一个都不能丢：之前只转发了三个，`conversationId` 被吃掉，
	 * 于是「A 会话报的错」在所有会话 / 所有窗口的提示条上都冒出来（用户报过）。
	 */
	const notice = (text: string, level: Notice["level"] = "info", key?: string, conversationId?: string): void =>
		void sink.push(text, level, key, conversationId);

	const approval = createApprovalBridge({
		rules: options.options.rules,
		now: options.now,
		nextId: options.nextId,
		onPending: options.onPending,
		onNotice: (text, level) => notice(text, level),
		modeOf: options.modeOf,
	});
	options.options.engine.setApprovalHandler(approval.handler);

	const watchdog = createRuntimeTurnWatchdog({
		timeoutMs: options.options.turnTimeoutMs,
		engine: options.options.engine,
		isWaitingForUser: options.isWaitingForUser,
		notice: (text, level) => notice(text, level),
	});

	return { notice, approval, watchdog };
}
