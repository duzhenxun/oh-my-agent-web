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

export type ApprovalResult = { ok: true } | { ok: false; error: ProtocolError };

export type ApprovalBridgeOptions = {
	rules: RuleStore;
	now: () => number;
	nextId: (prefix: string) => string;
	/** 弹窗状态变化时调用（null = 已清空） */
	onPending: (pending: PendingApproval | null) => void;
	onNotice: (text: string, level: "info" | "warn" | "error") => void;
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
	/** 回合结束时调用：把悬着的审批按「拒绝」收尾 */
	cancelPending: () => void;
	/** 审批模式（P4）：「全部放行」时 handler 直接返回 once，不再弹窗 */
	setMode: (mode: ApprovalMode) => void;
	mode: () => ApprovalMode;
};

export function createApprovalBridge(options: ApprovalBridgeOptions): ApprovalBridge {
	let rules: ApprovalRule[] = [];
	/** 本次运行内记住的（即使写盘失败也生效） */
	const sessionRules = new Set<string>();
	/**
	 * 审批模式：只在内存里（不落盘），**默认 allow**（ADR-0034）。
	 * 切到 allow 时，**下一次**需要审批的操作起就直接放行；已经悬着的那个弹窗不会凭空消失
	 * （用户仍能选），避免"点了放行却看到一个闪现消失的弹窗"。
	 */
	let approvalMode: ApprovalMode = "allow";
	let pending: {
		requestId: string;
		scopeKey: string;
		scopeHint: string;
		resolve: (decision: ApprovalDecision) => void;
	} | null = null;

	const bridge: ApprovalBridge = {
		async handler(request) {
			// 本会话全部放行：不问，直接 once（不记忆、不写盘，重启即恢复询问）
			if (approvalMode === "allow") return "once";
			if (sessionRules.has(request.scopeKey) || hasRule(rules, request.scopeKey)) return "always";

			const requestId = options.nextId("appr");
			options.onPending({
				requestId,
				toolName: request.toolName,
				argsSummary: request.argsSummary,
				riskNote: request.riskNote,
				scopeHint: request.scopeHint,
			});

			return new Promise<ApprovalDecision>((resolve) => {
				pending = { requestId, scopeKey: request.scopeKey, scopeHint: request.scopeHint, resolve };
			});
		},

		approve(requestId, decision) {
			if (!pending || pending.requestId !== requestId) {
				return { ok: false, error: { code: "approval.unknown_request", message: "没有待处理的审批请求" } };
			}
			const current = pending;
			pending = null;
			options.onPending(null);

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

			current.resolve(decision);
			return { ok: true };
		},

		async loadRules() {
			rules = await options.rules.load();
			return rules.length;
		},

		rulesCount() {
			return rules.length;
		},

		setMode(next) {
			approvalMode = next;
		},

		mode() {
			return approvalMode;
		},

		cancelPending() {
			if (!pending) return;
			const current = pending;
			pending = null;
			options.onPending(null);
			// 安全默认值：悬着的审批按拒绝收尾（绝不默认放行）
			current.resolve("deny");
		},
	};

	return bridge;
}
