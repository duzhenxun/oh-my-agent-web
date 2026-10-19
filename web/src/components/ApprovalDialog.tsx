import { useEffect, useState } from "react";
import type { Notice, PendingApproval } from "../types.ts";
import { approve } from "../ws.ts";

/**
 * 审批弹窗（ADR-0006 三态、ADR-0013：**除审批外不弹模态**）。
 * 「权限这类」的描述必须出现在按钮旁边 —— 用户得知道「总是允许」到底允许了什么。
 */
export function ApprovalDialog({ approval }: { approval: PendingApproval }) {
	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="危险操作确认">
			<div className="modal">
				<h2 className="modal-title">需要你确认</h2>
				<p className="modal-risk">{approval.riskNote}</p>
				<dl className="modal-facts">
					<dt>工具</dt>
					<dd>{approval.toolName}</dd>
					<dt>参数</dt>
					<dd className="mono">{approval.argsSummary}</dd>
					<dt>这类操作</dt>
					<dd className="mono">{approval.scopeHint}</dd>
				</dl>
				<div className="modal-actions">
					<button type="button" className="btn" onClick={() => approve(approval.requestId, "deny")}>
						拒绝
					</button>
					<button type="button" className="btn" onClick={() => approve(approval.requestId, "once")}>
						允许一次
					</button>
					<button type="button" className="btn btn-primary" onClick={() => approve(approval.requestId, "always")}>
						总是允许这类
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 提示条：每条带一个关闭按钮（点掉就不占对话高度了）。
 * 关闭状态只在前端记（按 notice.id 记），刷新页面会重新出现 —— 这些提示本来就是"临时状态"。
 */
const NOTICE_TTL_MS = 4000;

export function NoticeBar({ notices }: { notices: Notice[] }) {
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	// 自动消失：每 1s 重新算一次"哪些还没超时"（这类提示是瞬时的，不该一直占着对话高度）
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const visible = notices.filter((notice) => !dismissed.has(notice.id) && now - notice.ts < NOTICE_TTL_MS).slice(-3);
	if (visible.length === 0) return null;
	const dismiss = (id: string) =>
		setDismissed((current) => {
			const next = new Set(current);
			next.add(id);
			return next;
		});
	return (
		<div className="notices">
			{visible.map((notice) => (
				<div key={notice.id} className={`notice notice-${notice.level}`}>
					<span className="notice-text">{notice.text}</span>
					<button type="button" className="notice-close" onClick={() => dismiss(notice.id)} title="关闭这条提示">
						×
					</button>
				</div>
			))}
		</div>
	);
}
