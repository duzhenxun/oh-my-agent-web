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

export function NoticeBar({ notices }: { notices: Notice[] }) {
	const recent = notices.slice(-3);
	if (recent.length === 0) return null;
	return (
		<div className="notices">
			{recent.map((notice) => (
				<div key={notice.id} className={`notice notice-${notice.level}`}>
					{notice.text}
				</div>
			))}
		</div>
	);
}
