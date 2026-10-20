import { useStickToBottom } from "./stick-to-bottom.ts";
import { useEffect, useRef, useState } from "react";
import { clampSidebarWidth, readStoredWidth, SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_KEY } from "./sidebar-layout.ts";
import { setDraft, useAppState } from "./store.ts";
import { sessionIdFromUrl, sessionUrlFor } from "./session-url.ts";
import { cancelQueued, newChat, switchConversation } from "./ws.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ConversationOutline } from "./components/ConversationOutline.tsx";
import { SidebarMenu } from "./components/SidebarMenu.tsx";
import { PreviewPanel, type PanelItem } from "./components/PreviewPanel.tsx";
import { SessionInfo } from "./components/SessionInfo.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

export function App() {
	// 文件面板（M4）：跟着当前会话的工作区走
	// 侧栏：可收起 + 可拖宽（状态存 localStorage，刷新后保持）
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
	const [previewVisible, setPreviewVisible] = useState(true);
	const [sideWidth, setSideWidth] = useState(() => readStoredWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY)));
	const dragging = useRef(false);

	useEffect(() => {
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	}, [collapsed]);
	useEffect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sideWidth));
	}, [sideWidth]);

	// 顶栏真实高度写进 CSS 变量：手机抽屉要靠它贴合，写死数字会留一条缝
	useEffect(() => {
		const bar = document.querySelector(".appbar");
		if (!bar) return;
		const apply = () =>
			document.documentElement.style.setProperty("--appbar-h", `${(bar as HTMLElement).offsetHeight}px`);
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(bar);
		return () => observer.disconnect();
	}, []);

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
		// 只有地址栏仍保持初始值时才等待初始会话；用户点击侧栏后 ws.ts 已先改了地址，不能继续被旧值卡住。
		if (
			urlSession.current !== null &&
			sessionIdFromUrl(window.location.search) === urlSession.current &&
			snapshot.active.conversationId !== urlSession.current
		)
			return;
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
				<button
					type="button"
					className="appbar-drawer"
					onClick={() => setCollapsed((value) => !value)}
					title="项目列表"
					aria-label="项目列表"
				>
					☰
				</button>
				<span className="brand">
					<img className="brand-icon" src="/favicon.svg" alt="" aria-hidden="true" />
					Agent Web
				</span>
				<button type="button" className="appbar-new appbar-new-primary" onClick={() => newChat()} title="新建会话">
					<span className="appbar-new-icon" aria-hidden="true">
						💬
					</span>
					新会话
				</button>
				{/* 预留区：以后放全局搜索 / 命令面板 */}
				<span className="appbar-slot" />
				<SessionInfo snapshot={snapshot} />
				<SidebarMenu variant="full" placement="appbar" />
				{panelItems.length > 0 ? (
					<button
						type="button"
						className={`side-foot-btn appbar-panel-btn${previewVisible ? " side-foot-btn-on" : ""}`}
						onClick={() => setPreviewVisible((visible) => !visible)}
						title={previewVisible ? "收起右侧面板" : "展开右侧面板"}
					>
						<svg className="appbar-panel-icon" viewBox="0 0 16 16" aria-hidden="true">
							<rect
								x="1.6"
								y="2.6"
								width="12.8"
								height="10.8"
								rx="2.2"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
							/>
							<line x1="10.2" y1="2.6" x2="10.2" y2="13.4" stroke="currentColor" strokeWidth="1.4" />
						</svg>
						{previewVisible ? "收起" : "展开"}
					</button>
				) : null}
			</div>
			<div className="app-main">
				{collapsed ? null : (
					<>
						{/* 手机端：抽屉外的遮罩，点一下收起（桌面态 CSS 里 display:none） */}
						<div className="side-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
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
					</>
				)}

				<div className="workspace">
					<main className="main" ref={scroll.ref}>
						{snapshot ? (
							<MessageList
								messages={messages}
								hasMoreBefore={snapshot.active.hasMoreBefore}
								engine={snapshot.engine}
								actions={snapshot.actions}
								pending={(snapshot.queued ?? []).filter(
									(item) => item.conversationId === snapshot.active.conversationId,
								)}
								onRecallPending={(queueId: string) => {
									const item = snapshot.queued.find((entry) => entry.id === queueId);
									if (item) setDraft(item.text);
									cancelQueued(queueId);
								}}
								onCancelPending={(queueId: string) => cancelQueued(queueId)}
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
