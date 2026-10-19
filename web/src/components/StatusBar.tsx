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
export function StatusBar({ connection, snapshot }: { connection: string; snapshot: Snapshot | null }) {
	const running = Object.keys(snapshot?.runningByConversation ?? {}).length;
	const tokens = snapshot?.sessionStats?.totalTokens ?? 0;
	return (
		<footer className="statusbar">
			<span className={`status-dot status-dot-${connection}`} aria-hidden="true" />
			<span className="status-item">{CONNECTION[connection] ?? connection}</span>
			<span className="status-item">🧠 {snapshot?.engine ?? "—"}</span>
			<span className="status-item">💬 {snapshot?.conversations.length ?? 0} 个对话</span>
			<span className="status-item">⚙ 工作中 {running}</span>
			<span className="status-item">⏳ 排队 {snapshot?.queuedCount ?? 0}</span>
			<span className="status-spacer" />
			<span className="status-item" title="本会话累计 token">
				Σ {formatTokens(tokens)}
			</span>
			<span className="status-item status-path" title={snapshot?.files?.root ?? ""}>
				📁 {snapshot?.files?.root?.split("/").filter(Boolean).pop() ?? "—"}
			</span>
		</footer>
	);
}
