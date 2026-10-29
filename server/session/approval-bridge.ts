/**
 * 审批桥（ADR-0006）：把「引擎里的危险操作」与「界面上的一次点击」连起来。
 *
 * 职责就三件，刻意从 runtime 里拆出来（否则 runtime 会越过 400 行护栏，ADR-0010）：
 *   1. `handler`：引擎在危险操作前调它，返回 Promise 等用户决定；
 *   2. `approve`：界面点完按钮调它，解析那个 Promise；
 *   3. 规则：命中「总是允许这类」就直接放行（含跨重启的持久规则），并把新规则交给存储。
 *
 * 默认模式是 `allow`（ADR-0034：自己一个人用的工作台，默认不想被弹窗打断），
 * 但下面这条底线不变：
 *   - 没有 handler / 被取消 → **拒绝**（绝不因为"没接上"就放行）；
 *   - 回合结束时若还悬着一个审批 → 按「拒绝」收尾，不留下一个永远等不到答复的 Promise。
 */
import { hasRule, withRule, type ApprovalRule, type RuleStore } from "../approval/rules.js";
import type { ApprovalDecision, ApprovalMode, PendingApproval, ProtocolError } from "../protocol.js";
import type { ApprovalRequest } from "../engine/port.js";

type ApprovalResult = { ok: true } | { ok: false; error: ProtocolError };

type ApprovalBridgeOptions = {
	rules: RuleStore;
	now: () => number;
	nextId: (prefix: string) => string;
	/** 弹窗状态变化时调用（null = 已清空） */
	onPending: (pending: PendingApproval | null) => void;
	onNotice: (text: string, level: "info" | "warn" | "error") => void;
	/**
	 * 这个会话当前是「询问」还是「全部放行」。
	 *
	 * 模式归宿主（`state.approvalByConversation`）所有，桥只读不存：审批模式是**按会话**的，
	 * 桥自己留一份全局变量就会把 A 会话的选择带到 B 会话上。
	 * `conversationId` 拿不到（引擎没给归属）时按兜底值走。
	 */
	modeOf: (conversationId: string | null) => ApprovalMode;
};

export type ApprovalBridge = {
	/** 挂给引擎的钩子 */
	handler: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/** 界面决定入口 */
	approve: (requestId: string, decision: ApprovalDecision) => ApprovalResult;
	/** 启动时装载持久规则，返回装载条数 */
	loadRules: () => Promise<number>;
	/** 规则条数（提示牌与调试用） */
	rulesCount: () => number;
	/**
	 * 回合结束时调用：把**这个会话**悬着的审批按「拒绝」收尾。
	 *
	 * 必须按会话收：支持跨会话并行回合，全局收会把别的会话正等着的审批静默拒掉
	 * （A 会话等你点确认时，B 会话一回合一结束就把 A 的工具调用打回去了）。
	 *
	 * `allTurnsDone`：整个进程已经没有回合在跑了 —— 此时连「不知道归属」的审批也一并收掉，
	 * 免得留下一个永远等不到答复的 Promise。
	 */
	cancelPending: (conversationId: string | null, options?: { allTurnsDone?: boolean }) => void;
};

export function createApprovalBridge(options: ApprovalBridgeOptions): ApprovalBridge {
	let rules: ApprovalRule[] = [];
	/** 本次运行内记住的（即使写盘失败也生效） */
	const sessionRules = new Set<string>();
	/*
	 * 审批模式按**会话**读（`options.modeOf`），桥里不存状态：
	 * 切到 allow 时，**下一次**需要审批的操作起就直接放行；已经悬着的那个弹窗不会凭空消失
	 * （用户仍能选），避免"点了放行却看到一个闪现消失的弹窗"。
	 */

	/**
	 * 待审批队列（FIFO）。
	 *
	 * 以前只有**一个**槽位：两个会话同时要审批时，第二个会把第一个的 resolve 覆盖掉，
	 * 第一个回合就永远等不到答复（只能等看门狗超时）。现在按请求排队，
	 * 界面仍然一次只显示队首那条（协议里只有一个 `pendingApproval`）。
	 */
	type PendingEntry = {
		requestId: string;
		request: ApprovalRequest;
		scopeKey: string;
		scopeHint: string;
		/** 要审批的是哪个会话（引擎拿不到时是 null） */
		conversationId: string | null;
		settle: (decision: ApprovalDecision) => void;
	};
	const pending: PendingEntry[] = [];
	const viewOf = (entry: PendingEntry): PendingApproval => ({
		requestId: entry.requestId,
		toolName: entry.request.toolName,
		argsSummary: entry.request.argsSummary,
		riskNote: entry.request.riskNote,
		scopeHint: entry.request.scopeHint,
	});
	const showHead = (): void => {
		const head = pending[0];
		options.onPending(head ? viewOf(head) : null);
	};

	const bridge: ApprovalBridge = {
		async handler(request) {
			// 本会话全部放行：不问，直接 once（不记忆、不写盘，重启即恢复询问）
			if (options.modeOf(request.conversationId ?? null) === "allow") return "once";
			if (sessionRules.has(request.scopeKey) || hasRule(rules, request.scopeKey)) return "always";

			const requestId = options.nextId("appr");
			let settle: (decision: ApprovalDecision) => void = () => {};
			const promise = new Promise<ApprovalDecision>((resolve) => {
				settle = resolve;
			});
			pending.push({
				requestId,
				request,
				scopeKey: request.scopeKey,
				scopeHint: request.scopeHint,
				conversationId: request.conversationId ?? null,
				settle,
			});
			// 已经有一条在显示时不抢镜：等队首处理完再顶上（否则界面上那条会突然被换掉）
			if (pending.length === 1) options.onPending(viewOf(pending[0] as PendingEntry));
			return promise;
		},

		approve(requestId, decision) {
			const index = pending.findIndex((entry) => entry.requestId === requestId);
			const current = index >= 0 ? pending.splice(index, 1)[0] : undefined;
			if (!current) {
				return { ok: false, error: { code: "approval.unknown_request", message: "没有待处理的审批请求" } };
			}

			if (decision === "always") {
				sessionRules.add(current.scopeKey);
				const nextRules = withRule(rules, {
					scopeKey: current.scopeKey,
					scopeHint: current.scopeHint,
					createdAt: options.now(),
				});
				rules = nextRules;
				// 内存规则立即生效；写盘失败只影响下次启动 → 只警告，不阻塞回合
				void options.rules.save(nextRules).catch((error: unknown) => {
					options.onNotice(`审批规则写盘失败：${error instanceof Error ? error.message : String(error)}`, "warn");
				});
				options.onNotice(`已记住：以后这类操作不再询问（${current.scopeHint}）`, "info");
			}

			current.settle(decision);
			showHead(); // 队里还有下一条就顶上来，否则清空弹窗
			return { ok: true };
		},

		async loadRules() {
			rules = await options.rules.load();
			return rules.length;
		},

		rulesCount() {
			return rules.length;
		},

		cancelPending(conversationId, cancelOptions) {
			if (pending.length === 0) return;
			const head = pending[0];
			const keep: PendingEntry[] = [];
			const drop: PendingEntry[] = [];
			for (const entry of pending) {
				// 只收本会话的；「不知道归属」的只在全局都停下来了才收（保守：宁可多留一会儿）
				const mine = conversationId !== null && entry.conversationId === conversationId;
				const unknownOwner = entry.conversationId === null || conversationId === null;
				if (mine || (unknownOwner && cancelOptions?.allTurnsDone === true)) drop.push(entry);
				else keep.push(entry);
			}
			if (drop.length === 0) return;
			pending.length = 0;
			pending.push(...keep);
			// 只有「正显示的那条」被收掉了才动弹窗，否则会把别人的审批重发一遍
			if (head !== undefined && drop.includes(head)) showHead();
			// 安全默认值：被收掉的审批一律按拒绝收尾（绝不默认放行）
			for (const entry of drop) entry.settle("deny");
		},
	};

	return bridge;
}
