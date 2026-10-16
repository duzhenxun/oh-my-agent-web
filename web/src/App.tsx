import { useEffect, useRef } from "react";
import { useAppState } from "./store.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { Sidebar } from "./components/Sidebar.tsx";

const CONNECTION_LABEL = { connecting: "连接中…", open: "已连接", closed: "已断开（自动重连）" } as const;

const RUNNING_LABEL = {
	idle: "空闲",
	streaming: "正在回复",
	awaiting_approval: "等待审批",
	error: "上一回合出错",
} as const;

export function App() {
	const state = useAppState();
	const snapshot = state.snapshot;
	const messages = snapshot?.active.messages ?? [];
	const running = snapshot ? snapshot.running.status !== "idle" : false;
	const activeConversation = snapshot?.conversations.find((item) => item.id === snapshot.active.conversationId) ?? null;
	const scroller = useRef<HTMLDivElement>(null);

	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [messages.length, snapshot?.running.streamingText]);

	return (
		<div className="app">
			<Sidebar conversations={snapshot?.conversations ?? []} activeId={snapshot?.active.conversationId ?? null} />

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
					<span className="chip chip-quiet">协议 v{snapshot?.protocolVersion ?? "?"}</span>
				</header>

				<main className="main" ref={scroller}>
					{snapshot ? (
						<MessageList messages={messages} hasMoreBefore={snapshot.active.hasMoreBefore} />
					) : (
						<div className="empty">等待服务端快照…（后端没起来的话看终端日志）</div>
					)}
				</main>

				{state.lastError ? <div className="error-bar">{state.lastError}</div> : null}
				<NoticeBar notices={snapshot?.notices ?? []} />
				<Composer running={running} conversationId={snapshot?.active.conversationId ?? null} />
			</div>

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
		</div>
	);
}
