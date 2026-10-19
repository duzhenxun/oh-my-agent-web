import { useState } from "react";
import { cacheHitRate, formatPercent, formatSpan } from "../session-metrics.ts";
import type { Snapshot } from "../types.ts";

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * 顶栏「会话信息」：点一下展开明细（会话文件 / ID / 消息统计 / Token 统计 / 项目目录），
 * 再点一下收起。数据全部来自已有快照，不额外请求。
 */
export function SessionInfo({ snapshot }: { snapshot: Snapshot | null }) {
	const [open, setOpen] = useState(false);
	const stats = snapshot?.sessionStats;
	const activeId = snapshot?.active.conversationId ?? null;
	const activeSession =
		snapshot?.piProjects.flatMap((project) => project.sessions).find((session) => session.id === activeId) ?? null;
	const sessionPath = activeSession?.sessionPath ?? null;
	const value = stats ?? {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		contextTokens: 0,
	};
	const hitRate = formatPercent(cacheHitRate(value.inputTokens, value.cacheRead));
	// 活跃时长 = 会话创建到最后一次更新的跨度（wall clock，含空闲）
	const span = activeSession ? formatSpan(activeSession.updatedAt - activeSession.startedAt) : "—";

	const rows: Array<[string, string]> = [
		["会话文件", sessionPath ?? "（本地新建，尚未落盘）"],
		["ID", activeId ?? "—"],
		["活跃时长", span],
		["项目目录", snapshot?.files?.root ?? "—"],
	];

	return (
		<div className="session-info">
			<button
				type="button"
				className={`chip chip-quiet mono${open ? " chip-on" : ""}`}
				onClick={() => setOpen((value) => !value)}
			>
				↑ {formatTokens(value.inputTokens)} ↓ {formatTokens(value.outputTokens)} · 上下文{" "}
				{formatTokens(value.contextTokens)}
			</button>
			{open ? (
				<div className="session-info-pop">
					<div className="session-info-col session-info-wide">
						<div className="session-info-title">会话信息</div>
						{rows.map(([label, value]) => (
							<div className="session-info-row" key={label}>
								<span className="session-info-label">{label}</span>
								<span className="session-info-value mono">{value}</span>
							</div>
						))}
					</div>
					<div className="session-info-col">
						<div className="session-info-title">消息</div>
						{[
							["用户", formatNumber(value.userMessages)],
							["助手", formatNumber(value.assistantMessages)],
							["工具调用", formatNumber(value.toolCalls)],
							["工具结果", formatNumber(value.toolResults)],
							["总计", formatNumber(value.totalMessages)],
						].map(([label, value]) => (
							<div className="session-info-row" key={label}>
								<span className="session-info-label">{label}</span>
								<span className="session-info-value">{value}</span>
							</div>
						))}
					</div>
					<div className="session-info-col">
						<div className="session-info-title">Token</div>
						{[
							["输入", formatNumber(value.inputTokens)],
							["输出", formatNumber(value.outputTokens)],
							["缓存读取", formatNumber(value.cacheRead)],
							["缓存写入", formatNumber(value.cacheWrite)],
							["总计", formatNumber(value.totalTokens)],
							["上下文占用", formatNumber(value.contextTokens)],
							["缓存命中率", hitRate],
						].map(([label, value]) => (
							<div className="session-info-row" key={label}>
								<span className="session-info-label">{label}</span>
								<span className="session-info-value">{value}</span>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
