import { useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../types.ts";
import { setApprovalMode } from "../ws.ts";

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 底部状态栏：一眼看到"工作台现在是什么状态"。
 * 左：审批 / 排队 / 工作中 / 上下文；右：项目名 + 顶部栏开关。
 * 数据全部来自已有快照，不额外拉取。
 *
 * 为什么把「模型 / 强度 / 审批」放这里：它们改的是**这一次以及之后怎么跑**，
 * 不是要发出去的内容；放在输入框上方会跟「想说什么」挤在一起。
 */
export function StatusBar({
	snapshot,
	appbarHidden,
	onToggleAppbar,
}: {
	snapshot: Snapshot | null;
	/** 顶部栏是否收起（状态由 App 持有并持久化） */
	appbarHidden: boolean;
	onToggleAppbar: () => void;
}) {
	// 正在进行中的回合数：runningByConversation 里即使 idle 也会留条目，不能直接数 keys
	const running = Object.values(snapshot?.runningByConversation ?? {}).filter((item) => item.status !== "idle").length;
	const stats = snapshot?.sessionStats ?? null;
	// 上下文用量：sessionStats.contextTokens（最近一条 assistant 的输入侧）÷ 当前模型窗口。
	// 窗口大小客户端本来就有（快照里带着 providers → 每个模型的规格），不用再问服务端。
	const [providerName, ...modelRest] = String(snapshot?.model ?? "").split("/");
	const modelSpec = (snapshot?.providers ?? [])
		.find((provider) => provider.provider === providerName)
		?.models.find((model) => model.id === modelRest.join("/"));
	const contextWindow = modelSpec?.contextWindow && modelSpec.contextWindow > 0 ? modelSpec.contextWindow : null;
	const contextUsed = stats?.contextTokens ?? 0;
	const contextRatio = contextWindow ? Math.min(1, contextUsed / contextWindow) : 0;
	const contextPercent = contextWindow ? Math.round(contextRatio * 100) : null;
	/** 圆环：r=6 周长约 37.7，用 dasharray 画进度 */
	const RING = 37.7;
	const [usageOpen, setUsageOpen] = useState(false);
	/** 浮层锚点：贴着上下文胶囊**正上方**（状态栏是 overflow 容器，只能用 fixed + 现算坐标） */
	const [usageAnchor, setUsageAnchor] = useState<{ left: number; bottom: number } | null>(null);
	const contextRef = useRef<HTMLButtonElement>(null);
	const usagePopRef = useRef<HTMLDivElement>(null);

	// 打开后量一次：胶囊右边缘对齐浮层右边缘，再夹到视口内（窄屏上胶囊靠左时不会跑出屏幕）
	useLayoutEffect(() => {
		if (!usageOpen) {
			setUsageAnchor(null);
			return;
		}
		const chip = contextRef.current?.getBoundingClientRect();
		const pop = usagePopRef.current?.getBoundingClientRect();
		if (!chip || !pop) return;
		const left = Math.min(Math.max(8, chip.right - pop.width), window.innerWidth - pop.width - 8);
		setUsageAnchor({ left, bottom: window.innerHeight - chip.top + 8 });
	}, [usageOpen]);
	return (
		<footer className="statusbar">
			<span className="status-controls">
				{/* 审批模式在最前面：它是「这一步会不会被拦住」的开关，最该一眼看到 */}
				{snapshot?.engineCapabilities.approvals === false ? (
					<span className="tool-chip tool-static" title="该引擎自行决定授权，本工作台拦不住它的危险操作">
						🔒 审批：引擎自理
					</span>
				) : (
					<button
						type="button"
						className={`tool-chip${snapshot?.approvalMode === "allow" ? " tool-chip-warn" : ""}`}
						onClick={() => setApprovalMode(snapshot?.approvalMode === "allow" ? "ask" : "allow")}
						title="审批模式（全局生效，重启回到默认：全部放行）——点一下在「全部放行 / 询问」之间切换"
					>
						{snapshot?.approvalMode === "allow" ? "🔓 全部放行" : "🔒 询问"}
					</button>
				)}
			</span>
			<span className="status-item status-queued">
				<span className="status-ico">⏳</span> 排队 {snapshot?.queued.length ?? 0}
			</span>
			<span className={`status-item status-running${running > 0 ? " is-working" : ""}`}>
				{/* 有回合在跑时转起来（没跑就是个静止的小环） */}
				<span className="status-spinner" aria-hidden="true" />
				工作中 {running}
			</span>
			<span className="status-context-wrap">
				<button
					ref={contextRef}
					type="button"
					className="status-context"
					title={
						contextWindow
							? `当前会话上下文：已用 ${contextUsed.toLocaleString()} / 窗口 ${contextWindow.toLocaleString()}（${contextPercent}%）`
							: "当前会话上下文（模型窗口未知）"
					}
					onClick={() => setUsageOpen((value) => !value)}
				>
					<svg className="status-ring" viewBox="0 0 16 16" aria-hidden="true">
						<circle className="status-ring-bg" cx="8" cy="8" r="6" />
						<circle
							className="status-ring-fg"
							cx="8"
							cy="8"
							r="6"
							style={{ strokeDasharray: `${(contextRatio * RING).toFixed(2)} ${RING}` }}
						/>
					</svg>
					<span className="status-context-used">{formatTokens(contextUsed)}</span>
					<span className="status-context-total">/ {contextWindow ? formatTokens(contextWindow) : "—"}</span>
				</button>
				{usageOpen ? (
					<div
						ref={usagePopRef}
						className="status-usage-pop"
						role="dialog"
						aria-label="会话信息"
						// 先按「不可见」渲染一帧量出宽度，再落到最终位置（避免闪一下）
						style={usageAnchor ? { left: usageAnchor.left, bottom: usageAnchor.bottom } : { visibility: "hidden" }}
					>
						<div className="status-usage-title">会话信息</div>
						{[
							["用户消息", String(stats?.userMessages ?? 0)],
							["助手消息", String(stats?.assistantMessages ?? 0)],
							["工具调用", String(stats?.toolCalls ?? 0)],
							["输入 tokens", formatTokens(stats?.inputTokens ?? 0)],
							["输出 tokens", formatTokens(stats?.outputTokens ?? 0)],
							["缓存读", formatTokens(stats?.cacheRead ?? 0)],
							["缓存写", formatTokens(stats?.cacheWrite ?? 0)],
							[
								"上下文占用",
								contextWindow
									? `${formatTokens(contextUsed)} / ${formatTokens(contextWindow)}`
									: formatTokens(contextUsed),
							],
						].map(([label, value]) => (
							<div className="status-usage-row" key={label}>
								<span>{label}</span>
								<span className="mono">{value}</span>
							</div>
						))}
					</div>
				) : null}
			</span>
			<span className="status-spacer" />
			{/* 当前项目：放在右端、「顶部」开关前面（左边留给状态与配置） */}
			<span className="status-item status-path" title={snapshot?.files?.root ?? ""}>
				📁 {snapshot?.files?.root?.split("/").filter(Boolean).pop() ?? "—"}
			</span>
			<button
				type="button"
				className="status-toggle"
				onClick={onToggleAppbar}
				title={appbarHidden ? "显示顶部栏" : "隐藏顶部栏"}
			>
				<span className="status-toggle-icon">{appbarHidden ? "▾" : "▴"}</span>
				<span className="status-toggle-label">顶部</span>
			</button>
		</footer>
	);
}
