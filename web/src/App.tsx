import { useStickToBottom } from "./stick-to-bottom.ts";
import { useEffect, useRef, useState } from "react";
import { clampSidebarWidth, readStoredWidth, SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_KEY } from "./sidebar-layout.ts";
import { useAppState } from "./store.ts";
import { sessionIdFromUrl, sessionUrlFor } from "./session-url.ts";
import { newChat, switchConversation } from "./ws.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ConversationOutline } from "./components/ConversationOutline.tsx";
import { SidebarMenu } from "./components/SidebarMenu.tsx";
import { PreviewPanel, type PanelItem } from "./components/PreviewPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

/** 148242 → 148k（顶栏空间有限，只保留一位小数） */
function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function App() {
	// 文件面板（M4）：跟着当前会话的工作区走
	// 侧栏：可收起 + 可拖宽（状态存 localStorage，刷新后保持）
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
	const [pendingPanel, setPendingPanel] = useState<"models" | "skills" | "settings" | null>(null);
	const [previewVisible, setPreviewVisible] = useState(true);
	const [sideWidth, setSideWidth] = useState(() => readStoredWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY)));
	const dragging = useRef(false);

	useEffect(() => {
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	}, [collapsed]);
	useEffect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sideWidth));
	}, [sideWidth]);

	// 拖拽：pointer 事件挂在 document 上，鼠标移出侧栏边缘也不会中断
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		const startX = event.clientX;
		const startWidth = sideWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			setSideWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX)));
		};
		const onUp = () => {
			dragging.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};
	// 右侧面板的标签：文件与终端共用（终端也在右侧，标签上标出来）
	const [panelItems, setPanelItems] = useState<PanelItem[]>([]);
	const [activeItem, setActiveItem] = useState<string | null>(null);
	const [termSeq, setTermSeq] = useState(0);
	const state = useAppState();
	const snapshot = state.snapshot;
	const messages = snapshot?.active.messages ?? [];
	// 地址栏 ↔ 当前会话（?session=xxx）
	const urlSession = useRef<string | null>(sessionIdFromUrl(window.location.search));
	const appliedUrlSession = useRef(false);
	useEffect(() => {
		// 连上之后把地址栏里的会话打开（只做一次）
		if (appliedUrlSession.current || state.connection !== "open") return;
		appliedUrlSession.current = true;
		if (urlSession.current) void switchConversation(urlSession.current);
	}, [state.connection]);
	useEffect(() => {
		if (!snapshot) return;
		// 地址栏里指定的会话还没打开时先别改地址，否则会被"默认会话"覆盖掉
		if (urlSession.current !== null && snapshot.active.conversationId !== urlSession.current) return;
		urlSession.current = null;
		const href = sessionUrlFor(window.location.href, snapshot.active.conversationId);
		if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
			window.history.replaceState(null, "", href);
		}
	}, [snapshot?.active.conversationId]);

	// 粘底滚动：条数、末条正文长度、流式文本任一变化都算「内容更新」
	const lastTextLength =
		messages.at(-1)?.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.text.length : 0), 0) ?? 0;
	const scroll = useStickToBottom(
		`${messages.length}:${lastTextLength}:${snapshot?.running.streamingText?.length ?? 0}:${snapshot?.active.conversationId ?? ""}`,
	);

	return (
		<div className="app">
			{/* 顶部区域：横跨整个宽度，三栏都在它下面 */}
			<div className="appbar">
				<span className="brand">agent-web</span>
				<button type="button" className="appbar-new appbar-new-primary" onClick={() => newChat()} title="新建会话">
					＋ 新会话
				</button>
				{/* 预留区：以后放全局搜索 / 命令面板 */}
				<span className="appbar-slot" />
				{snapshot?.sessionStats ? (
					<span
						className="chip chip-quiet mono"
						title={[
							`消息：用户 ${snapshot.sessionStats.userMessages} / 助手 ${snapshot.sessionStats.assistantMessages} / 工具 ${snapshot.sessionStats.toolCalls}`,
							`Token：输入 ${snapshot.sessionStats.inputTokens} · 输出 ${snapshot.sessionStats.outputTokens} · 缓存读 ${snapshot.sessionStats.cacheRead}`,
							`上下文占用：${snapshot.sessionStats.contextTokens}`,
						].join("\n")}
					>
						↑ {formatTokens(snapshot.sessionStats.inputTokens)} ↓ {formatTokens(snapshot.sessionStats.outputTokens)} ·
						上下文 {formatTokens(snapshot.sessionStats.contextTokens)}
					</span>
				) : null}
				<SidebarMenu variant="full" placement="appbar" />
				{panelItems.length > 0 ? (
					<button
						type="button"
						className={`chip chip-quiet${previewVisible ? " chip-on" : ""}`}
						onClick={() => setPreviewVisible((visible) => !visible)}
						title={previewVisible ? "收起右侧面板" : "展开右侧面板"}
					>
						▤ 面板
					</button>
				) : null}
			</div>
			<div className="app-main">
				{collapsed ? (
					<aside className="activity-bar">
						<button type="button" className="activity-btn" onClick={() => setCollapsed(false)} title="展开侧栏">
							›
						</button>
						<button type="button" className="activity-btn" onClick={() => setCollapsed(false)} title="会话">
							💬
						</button>
						<button type="button" className="activity-btn" onClick={() => setPendingPanel("models")} title="模型">
							🤖
						</button>
						<button type="button" className="activity-btn" onClick={() => setPendingPanel("skills")} title="技能">
							🧰
						</button>
						<button type="button" className="activity-btn" onClick={() => setPendingPanel("settings")} title="设置">
							⚙
						</button>
						<button
							type="button"
							className="activity-btn"
							onClick={() => setCollapsed(false)}
							title="文件（在侧栏下方）"
						>
							📁
						</button>
						{pendingPanel ? <SidebarMenu key={pendingPanel} initialPanel={pendingPanel} variant="modal" /> : null}
					</aside>
				) : (
					<div className="side-host" style={{ width: sideWidth }}>
						<Sidebar
							conversations={snapshot?.conversations ?? []}
							activeId={snapshot?.active.conversationId ?? null}
							piProjects={snapshot?.piProjects ?? []}
							onCollapse={() => setCollapsed(true)}
							runningIds={Object.keys(snapshot?.runningByConversation ?? {})}
							onOpenTerminal={(cwd) => {
								const id = `term:${termSeq}:${cwd}`;
								setTermSeq((value) => value + 1);
								setPanelItems((current) => [...current, { id, kind: "terminal", cwd }]);
								setActiveItem(id);
							}}
							onOpenFile={(path, root) => {
								const id = `file:${root}:${path}`;
								setPanelItems((current) =>
									current.some((item) => item.id === id) ? current : [...current, { id, kind: "file", path, root }],
								);
								setActiveItem(id);
							}}
						/>
						{/* 拖拽条：右边边缘 6px，双击回到默认宽度 */}
						<div
							className="side-resizer"
							role="separator"
							aria-orientation="vertical"
							title="拖动调整宽度（双击复位）"
							onPointerDown={startResize}
							onDoubleClick={() => setSideWidth(readStoredWidth(null))}
						/>
					</div>
				)}

				<div className="workspace">
					<main className="main" ref={scroll.ref}>
						{snapshot ? (
							<MessageList
								messages={messages}
								hasMoreBefore={snapshot.active.hasMoreBefore}
								engine={snapshot.engine}
								actions={snapshot.actions}
								running={
									snapshot?.running.status !== "idle" &&
									snapshot?.running.conversationId === snapshot?.active.conversationId
								}
							/>
						) : (
							<div className="empty">等待服务端快照…（后端没起来的话看终端日志）</div>
						)}
						{scroll.stuck ? null : (
							<button type="button" className="jump-bottom" onClick={scroll.toBottom} title="回到最新">
								↓ 回到底部
							</button>
						)}
					</main>
					<ConversationOutline messages={messages} />

					{state.lastError ? <div className="error-bar">{state.lastError}</div> : null}
					<NoticeBar notices={snapshot?.notices ?? []} />
					<Composer
						running={
							snapshot?.running.status !== "idle" &&
							snapshot?.running.conversationId === (snapshot?.active.conversationId ?? null)
						}
						conversationId={snapshot?.active.conversationId ?? null}
					/>
				</div>

				{panelItems.length > 0 && previewVisible ? (
					<PreviewPanel
						items={panelItems}
						activeId={activeItem ?? panelItems[0]?.id ?? ""}
						onActivate={setActiveItem}
						onCloseItem={(id) => {
							setPanelItems((current) => current.filter((item) => item.id !== id));
							if (activeItem === id) setActiveItem(null);
						}}
						onCloseAll={() => {
							setPanelItems([]);
							setActiveItem(null);
						}}
					/>
				) : null}
			</div>

			<StatusBar connection={state.connection} snapshot={snapshot} />

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
		</div>
	);
}
