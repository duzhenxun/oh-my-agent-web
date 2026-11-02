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
import { StatusDot, compact, costText, duration, isActive, relativeTime, statusLabel } from "../subagent-view.tsx";
import { useT } from "../use-language.ts";
import { formatElapsedSeconds } from "../lib/duration-label.ts";

/** 会话文件路径太长：只显示末尾几段（完整路径在 title 里） */
function shortPath(path: string): string {
	return tailSegments(path, 3);
}

export function AgentsRunCard({
	run,
	now,
	queueHint,
}: {
	run: SubagentRunView;
	now: number;
	/** 排队中的补充说明（第几位 / 并发上限）—— 只有 queued 才用得上 */
	queueHint?: string;
}) {
	const [open, setOpen] = useState(false);
	const t = useT();
	const active = isActive(run);
	const text = run.status === "failed" ? (run.error ?? "") : (run.result ?? "");
	const tool = run.activeTool;
	/** 卡片标题就是一个按钮：点它展开/收起（不用先去找下面那颗小按钮） */
	const toggle = () => setOpen((value) => !value);
	return (
		<li className={`agents-run agents-strip-card agents-run-${run.status}`}>
			<div className="agents-run-head">
				<span className={`agents-run-status agents-status-${run.status}`}>
					<StatusDot status={run.status} />
					{statusLabel(run.status)}
				</span>
				<button
					type="button"
					className="agents-run-title agents-run-open"
					title={`${run.task}\n\n${t("点一下看它现在在跑什么", "Click to see what it is doing right now")}`}
					aria-expanded={open}
					onClick={toggle}
				>
					{run.description || run.label}
				</button>
				{active ? (
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => interruptSubagent(run.id)}
						title={
							run.status === "queued"
								? t("取消排队（不动已开跑的）", "Drop it from the queue (running ones keep going)")
								: t("停掉这个子代理（不动主会话）", "Stop this subagent (the main conversation keeps going)")
						}
					>
						{run.status === "queued" ? t("取消", "Cancel") : t("停止", "Stop")}
					</button>
				) : null}
			</div>
			{run.status === "queued" ? (
				<div className="agents-run-queue">
					<span aria-hidden="true">⏳</span>
					<span>
						{queueHint ?? t("排队中：等前面跑完就会自动开", "Queued: it starts as soon as an earlier one finishes")}
					</span>
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
						<span>{t(`${run.toolCalls} 次工具`, `${run.toolCalls} tool calls`)}</span>
					</>
				) : null}
				{run.tokens?.total ? (
					<>
						<span>·</span>
						<span>{compact(run.tokens.total)} tokens</span>
					</>
				) : null}
				{run.cost ? (
					<>
						<span>·</span>
						<span>{costText(run.cost)}</span>
					</>
				) : null}
			</div>
			{/* 跑着的时候：一行「此刻在跑哪个工具」—— 不展开也能看出它在动 */}
			{active && tool ? (
				<div className="agents-run-now" title={tool.argsSummary}>
					<span aria-hidden="true">⚙</span>
					<span className="agents-run-now-name">{tool.name}</span>
					<span className="agents-run-now-args">{tool.argsSummary}</span>
				</div>
			) : null}
			{text || active ? (
				<>
					<button type="button" className="agents-run-toggle" onClick={toggle}>
						{open
							? t("收起", "Hide")
							: active
								? t("看它现在在干什么", "See what it is doing")
								: t("查看结果", "View result")}
					</button>
					{open ? (
						<>
							{text ? (
								<pre className="agents-run-body">{text}</pre>
							) : (
								<pre className="agents-run-body agents-run-body-empty">
									{t(
										"还没有输出（模型还在想 / 正在跑工具）",
										"Nothing yet — the model is still thinking or running a tool",
									)}
								</pre>
							)}
							{active && tool ? (
								<div className="agents-run-tool">
									<span aria-hidden="true">⚙</span>{" "}
									{t(
										`正在跑 ${tool.name} · ${formatElapsedSeconds((now - tool.startedAt) / 1000)}`,
										`running ${tool.name} · ${formatElapsedSeconds((now - tool.startedAt) / 1000)}`,
									)}
								</div>
							) : null}
							{run.sessionPath ? (
								<div className="agents-run-path" title={run.sessionPath}>
									{t("会话文件：", "Session file: ")}
									{shortPath(run.sessionPath)}
								</div>
							) : null}
						</>
					) : null}
				</>
			) : null}
		</li>
	);
}
