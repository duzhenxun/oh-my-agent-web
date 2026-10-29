/**
 * 一条子代理运行的卡片（对话区下方的卡片条用；结果就地展开，不去面板里翻）。
 *
 * 数字口径与顶栏浮层一致（`subagent-view.ts` 的同一套函数）：耗时 / token / 花费
 * 三处显示必须能对上，否则用户会怀疑是不是两个东西。
 */
import { useState } from "react";
import { interruptSubagent } from "../ws.ts";
import type { SubagentRunView } from "../types.ts";
import { tailSegments } from "../path-utils.ts";
import { STATUS_LABEL, StatusDot, compact, costText, duration, isActive, relativeTime } from "../subagent-view.tsx";

/** 会话文件路径太长：只显示末尾几段（完整路径在 title 里） */
function shortPath(path: string): string {
	return tailSegments(path, 3);
}

export function AgentsRunCard({
	run,
	now,
	queueHint,
	showCost = true,
}: {
	run: SubagentRunView;
	now: number;
	/** 排队中的补充说明（第几位 / 并发上限）—— 只有 queued 才用得上 */
	queueHint?: string;
	/** 金额显不显示（由卡片条按本机偏好传下来，手机默认不显示） */
	showCost?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const active = isActive(run);
	const text = run.status === "failed" ? (run.error ?? "") : (run.result ?? "");
	return (
		<li className={`agents-run agents-strip-card agents-run-${run.status}`}>
			<div className="agents-run-head">
				<span className={`agents-run-status agents-status-${run.status}`}>
					<StatusDot status={run.status} />
					{STATUS_LABEL[run.status]}
				</span>
				<span className="agents-run-title" title={run.task}>
					{run.description || run.label}
				</span>
				{active ? (
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => interruptSubagent(run.id)}
						title={run.status === "queued" ? "取消排队（不动已开跑的）" : "停掉这个子代理（不动主会话）"}
					>
						{run.status === "queued" ? "取消" : "停止"}
					</button>
				) : null}
			</div>
			{run.status === "queued" ? (
				<div className="agents-run-queue">
					<span aria-hidden="true">⏳</span>
					<span>{queueHint ?? "排队中：等前面跑完就会自动开"}</span>
				</div>
			) : null}
			<div className="agents-run-meta">
				<span>{run.label}</span>
				<span>·</span>
				<span>{relativeTime(run.startedAt, now)}</span>
				<span>·</span>
				<span>{duration(run, now)}</span>
				{run.toolCalls ? (
					<>
						<span>·</span>
						<span>{run.toolCalls} 次工具</span>
					</>
				) : null}
				{run.tokens?.total ? (
					<>
						<span>·</span>
						<span>{compact(run.tokens.total)} tokens</span>
					</>
				) : null}
				{showCost && run.cost ? (
					<>
						<span>·</span>
						<span>{costText(run.cost)}</span>
					</>
				) : null}
			</div>
			{text ? (
				<>
					<button type="button" className="agents-run-toggle" onClick={() => setOpen((value) => !value)}>
						{open ? "收起结果" : "查看结果"}
					</button>
					{open ? (
						<>
							<pre className="agents-run-body">{text}</pre>
							{run.sessionPath ? (
								<div className="agents-run-path" title={run.sessionPath}>
									会话文件：{shortPath(run.sessionPath)}
								</div>
							) : null}
						</>
					) : null}
				</>
			) : null}
		</li>
	);
}
