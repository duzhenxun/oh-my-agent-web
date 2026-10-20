import type { ReactNode } from "react";
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
	const running = Object.keys(snapshot?.runningByConversation ?? {}).length;
	const stats = snapshot?.sessionStats ?? null;
	return (
		<footer className="statusbar">
			<span className={`status-dot status-dot-${connection}`} aria-hidden="true" />
			<span className="status-item">{CONNECTION[connection] ?? connection}</span>
			<span className="status-item">🧠 {snapshot?.engine ?? "—"}</span>
			<span className="status-item">💬 {snapshot?.conversations.length ?? 0} 个对话</span>
			<span className="status-item">⚙ 工作中 {running}</span>
			<span className="status-item">⏳ 排队 {snapshot?.queued.length ?? 0}</span>
			{stats ? (
				<span className="status-item status-usage" title="本会话累计输入 / 输出 / 当前上下文占用">
					↑ {formatTokens(stats.inputTokens)} ↓ {formatTokens(stats.outputTokens)} · 上下文{" "}
					{formatTokens(stats.contextTokens)}
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
