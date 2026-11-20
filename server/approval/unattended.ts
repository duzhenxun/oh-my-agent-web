/**
 * 「无人值守运行」的审批策略（cron 的 agent 任务用）。
 *
 * 为什么必须在审批**之前**裁决：无人值守时没人在场点按钮，
 * 让请求进排队队列 = 回合一直挂着，直到看门狗超时 —— 任务永远是「失败」，还白烧 token。
 *
 * 两条底线：
 *   1. 默认 `deny-writes`：需要审批的操作一律**拒绝**，agent 只能读、不能改；
 *   2. 裁决**绝不写盘**（返回 `"once"` 而不是 `"always"`）：不给用户的审批规则里
 *      留下「某个 3 点钟的定时任务允许过 rm」这种记录。
 *
 * 策略按会话登记，与 `state.approvalByConversation` 各管一段：
 * 后者决定「要不要问」，这里决定「问了以后谁答」。
 */
import type { ApprovalDecision } from "../protocol.js";
import type { ApprovalRequest } from "../engine/port.js";

export type UnattendedPolicy = "deny-writes" | "allow";

const policies = new Map<string, UnattendedPolicy>();

export function setUnattendedPolicy(conversationId: string, policy: UnattendedPolicy): void {
	policies.set(conversationId, policy);
}

export function clearUnattendedPolicy(conversationId: string): void {
	policies.delete(conversationId);
}

/** 当前会话是否处于无人值守（供测试与调试观察） */
export function unattendedPolicyOf(conversationId: string | null | undefined): UnattendedPolicy | null {
	if (!conversationId) return null;
	return policies.get(conversationId) ?? null;
}

/**
 * 引擎发来审批请求时的自动裁决；返回 `null` = 不干预，走正常的人工流程。
 *
 * 注意顺序：调用方（审批桥）**先**看会话模式是 allow → 那一步已经放行，
 * 这里只处理「模式是 ask、但这条会话是无人值守」的情况。
 */
export function unattendedDecision(request: ApprovalRequest): ApprovalDecision | null {
	const policy = unattendedPolicyOf(request.conversationId);
	if (!policy) return null;
	return policy === "allow" ? "once" : "deny";
}
