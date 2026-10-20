import { useState, type ReactNode } from "react";
import type { Snapshot } from "../types.ts";

const CONNECTION: Record<string, string> = { connecting: "连接中", open: "已连接", closed: "已断开" };

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 底部状态栏：一眼看到"工作台现在是什么状态"。
 * 左：连接 / 引擎 / 对话数 / 工作中 / 排队；右：会话 token / 项目路径。
 * 数据全部来自已有快照，不额外拉取。
 */
export function StatusBar({
	connection,
	snapshot,
	appbarHidden,
	onToggleAppbar,
	sidebarOpen,
	onToggleSidebar,
	children,
}: {
	connection: string;
	snapshot: Snapshot | null;
	/** 顶部栏是否收起（状态由 App 持有并持久化） */
	appbarHidden: boolean;
	onToggleAppbar: () => void;
	/** 左侧栏是否展开 */
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
	/** 右侧工具入口（模型 / 技能 / 设置），从顶栏挪下来的 */
	children?: ReactNode;
}) {
	// 正在进行中的回合数：runningByConversation 里即使 idle 也会留条目，不能直接数 keys
	const running = Object.values(snapshot?.runningByConversation ?? {}).filter((item) => item.status !== "idle").length;
	// 对话数：pi 的会话列表才是全量（我们自己新建的会话也落在 pi 存储里）
	const piSessions = (snapshot?.piProjects ?? []).reduce((sum, project) => sum + project.sessions.length, 0);
	const conversations = piSessions > 0 ? piSessions : (snapshot?.conversations.length ?? 0);
	const stats = snapshot?.sessionStats ?? null;
	const [usageOpen, setUsageOpen] = useState(false);
	return (
		<footer className="statusbar">
			<span className={`status-dot status-dot-${connection}`} aria-hidden="true" />
			<span className="status-item">{CONNECTION[connection] ?? connection}</span>
			<span className="status-item">🧠 {snapshot?.engine ?? "—"}</span>
			<span className="status-item status-conv">💬 {conversations} 个对话</span>
			<span className="status-item status-running">⚙ 工作中 {running}</span>
			<span className="status-item status-queued">⏳ 排队 {snapshot?.queued.length ?? 0}</span>
			{stats ? (
				<span className="status-usage-wrap">
					{usageOpen ? (
						<div className="status-usage-pop" role="dialog" aria-label="会话信息">
							<div className="status-usage-title">会话信息</div>
							{[
								["用户消息", String(stats.userMessages)],
								["助手消息", String(stats.assistantMessages)],
								["工具调用", String(stats.toolCalls)],
								["输入 tokens", formatTokens(stats.inputTokens)],
								["输出 tokens", formatTokens(stats.outputTokens)],
								["缓存读", formatTokens(stats.cacheRead)],
								["缓存写", formatTokens(stats.cacheWrite)],
								["上下文占用", formatTokens(stats.contextTokens)],
							].map(([label, value]) => (
								<div className="status-usage-row" key={label}>
									<span>{label}</span>
									<span className="mono">{value}</span>
								</div>
							))}
						</div>
					) : null}
					<button
						type="button"
						className="status-item status-usage"
						title="点开看会话信息"
						onClick={() => setUsageOpen((value) => !value)}
					>
						<span className="tok-in">↑ {formatTokens(stats.inputTokens)}</span>{" "}
						<span className="tok-out">↓ {formatTokens(stats.outputTokens)}</span> · 上下文{" "}
						{formatTokens(stats.contextTokens)}
					</button>
				</span>
			) : null}
			<span className="status-spacer" />
			{children ? <span className="statusbar-tools">{children}</span> : null}
			<button
				type="button"
				className="status-toggle"
				onClick={onToggleSidebar}
				title={sidebarOpen ? "隐藏左侧栏" : "显示左侧栏"}
			>
				{sidebarOpen ? "◀ 左侧" : "▶ 左侧"}
			</button>
			<button
				type="button"
				className="status-toggle"
				onClick={onToggleAppbar}
				title={appbarHidden ? "显示顶部栏" : "隐藏顶部栏"}
			>
				{appbarHidden ? "▾ 顶部" : "▴ 顶部"}
			</button>
			<span className="status-item status-path" title={snapshot?.files?.root ?? ""}>
				📁 {snapshot?.files?.root?.split("/").filter(Boolean).pop() ?? "—"}
			</span>
		</footer>
	);
}
