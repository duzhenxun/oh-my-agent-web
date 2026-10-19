import { useStickToBottom } from "./stick-to-bottom.ts";
import { useEffect, useRef, useState } from "react";
import { clampSidebarWidth, readStoredWidth, SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_KEY } from "./sidebar-layout.ts";
import { useAppState } from "./store.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { FilePreview } from "./components/FilePreview.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SidebarMenu } from "./components/SidebarMenu.tsx";

const CONNECTION_LABEL = { connecting: "连接中…", open: "已连接", closed: "已断开（自动重连）" } as const;

const RUNNING_LABEL = {
	idle: "空闲",
	streaming: "正在回复",
	awaiting_approval: "等待审批",
	error: "上一回合出错",
} as const;

export function App() {
	// 文件面板（M4）：跟着当前会话的工作区走
	const [filePanelOpen, setFilePanelOpen] = useState(false);
	const [terminalOpen, setTerminalOpen] = useState(false);
	// 侧栏：可收起 + 可拖宽（状态存 localStorage，刷新后保持）
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
	const [pendingPanel, setPendingPanel] = useState<"models" | "skills" | "settings" | null>(null);
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
	const [previewPath, setPreviewPath] = useState<string | null>(null);
	const state = useAppState();
	const snapshot = state.snapshot;
	const messages = snapshot?.active.messages ?? [];
	const running = snapshot ? snapshot.running.status !== "idle" : false;
	// 粘底滚动：条数、末条正文长度、流式文本任一变化都算「内容更新」
	const lastTextLength =
		messages.at(-1)?.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.text.length : 0), 0) ?? 0;
	const scroll = useStickToBottom(
		`${messages.length}:${lastTextLength}:${snapshot?.running.streamingText?.length ?? 0}:${snapshot?.active.conversationId ?? ""}`,
	);

	return (
		<div className="app">
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
						onClick={() => setFilePanelOpen((open) => !open)}
						title="文件列表"
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
						runningConversationId={
							snapshot?.running.status === "idle" ? null : (snapshot?.running.conversationId ?? null)
						}
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
				<header className="topbar">
					<span className="brand">agent-web</span>
					<span className={`chip chip-${state.connection}`}>{CONNECTION_LABEL[state.connection]}</span>
					{snapshot ? (
						<span className={`chip chip-run-${snapshot.running.status}`}>{RUNNING_LABEL[snapshot.running.status]}</span>
					) : null}
					<span className="topbar-spacer" />
					<button
						type="button"
						className={`chip chip-quiet${filePanelOpen ? " chip-on" : ""}`}
						onClick={() => setFilePanelOpen((open) => !open)}
						title="文件列表（当前项目）"
					>
						📁 文件
					</button>
					<button
						type="button"
						className={`chip chip-quiet${terminalOpen ? " chip-on" : ""}`}
						onClick={() => setTerminalOpen((open) => !open)}
						title="终端（在项目目录里跑命令）"
					>
						⌨ 终端
					</button>
				</header>

				<main className="main" ref={scroll.ref}>
					{snapshot ? (
						<MessageList
							messages={messages}
							hasMoreBefore={snapshot.active.hasMoreBefore}
							engine={snapshot.engine}
							actions={snapshot.actions}
							running={running}
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

				{state.lastError ? <div className="error-bar">{state.lastError}</div> : null}
				<NoticeBar notices={snapshot?.notices ?? []} />
				<Composer running={running} conversationId={snapshot?.active.conversationId ?? null} />
			</div>

			{filePanelOpen ? (
				<aside className="file-panel">
					<div className="file-panel-head">
						<span>文件列表</span>
						<span className="topbar-spacer" />
						<button type="button" className="btn btn-tiny" onClick={() => setFilePanelOpen(false)}>
							收起
						</button>
					</div>
					<FileTree root={snapshot?.files?.root ?? null} onOpenFile={setPreviewPath} />
				</aside>
			) : null}

			{terminalOpen ? <TerminalPanel onClose={() => setTerminalOpen(false)} /> : null}

			{previewPath ? <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} /> : null}

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
		</div>
	);
}
