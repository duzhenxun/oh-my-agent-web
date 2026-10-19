import { useEffect, useRef } from "react";
import { useState } from "react";
import { useAppState } from "./store.ts";
import { setApprovalMode, setModel } from "./ws.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { FilePreview } from "./components/FilePreview.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { Sidebar } from "./components/Sidebar.tsx";

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
	const [previewPath, setPreviewPath] = useState<string | null>(null);
	const state = useAppState();
	const snapshot = state.snapshot;
	const messages = snapshot?.active.messages ?? [];
	const running = snapshot ? snapshot.running.status !== "idle" : false;
	// 活动会话的标题：先找自己的会话，再回退到 pi 的项目列表（ADR-0021 §2 起两者都能被打开）
	const activeId = snapshot?.active.conversationId ?? null;
	const activeConversation =
		snapshot?.conversations.find((item) => item.id === activeId) ??
		snapshot?.piProjects.flatMap((project) => project.sessions).find((session) => session.id === activeId) ??
		null;
	const scroller = useRef<HTMLDivElement>(null);

	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [messages.length, snapshot?.running.streamingText]);

	return (
		<div className="app">
			<Sidebar
				conversations={snapshot?.conversations ?? []}
				activeId={snapshot?.active.conversationId ?? null}
				piProjects={snapshot?.piProjects ?? []}
			/>

			<div className="workspace">
				<header className="topbar">
					<span className="brand">agent-web</span>
					<span className={`chip chip-${state.connection}`}>{CONNECTION_LABEL[state.connection]}</span>
					{snapshot ? (
						<span className={`chip chip-run-${snapshot.running.status}`}>{RUNNING_LABEL[snapshot.running.status]}</span>
					) : null}
					<span className="topbar-spacer" />
					{activeConversation ? <span className="chip chip-quiet">{activeConversation.title}</span> : null}
					{snapshot?.files ? <span className="chip chip-quiet mono">{snapshot.files.root}</span> : null}
					{snapshot ? <span className="chip chip-quiet">引擎 {snapshot.engine}</span> : null}
					{snapshot && snapshot.models.length > 0 ? (
						<select
							className="chip chip-select mono"
							value={snapshot.model ?? ""}
							onChange={(event) => setModel(event.target.value)}
							title="切换这个会话使用的模型"
						>
							{snapshot.model && !snapshot.models.some((model) => model.id === snapshot.model) ? (
								<option value={snapshot.model}>{snapshot.model}</option>
							) : null}
							{snapshot.models.map((model) => (
								<option key={model.id} value={model.id}>
									{model.label}
								</option>
							))}
						</select>
					) : snapshot?.model ? (
						<span className="chip chip-quiet mono">{snapshot.model}</span>
					) : null}
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
						className={`chip ${snapshot?.approvalMode === "allow" ? "chip-warn" : "chip-quiet"}`}
						onClick={() => setApprovalMode(snapshot?.approvalMode === "allow" ? "ask" : "allow")}
						title="审批模式（只在本会话生效，重启恢复询问）"
					>
						{snapshot?.approvalMode === "allow" ? "审批：全部放行" : "审批：询问"}
					</button>
					<span className="chip chip-quiet">协议 v{snapshot?.protocolVersion ?? "?"}</span>
				</header>

				<main className="main" ref={scroller}>
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

			{previewPath ? <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} /> : null}

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
		</div>
	);
}
