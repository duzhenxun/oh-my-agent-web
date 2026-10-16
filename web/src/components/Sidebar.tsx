import type { ConversationMeta, PiProject } from "../types.ts";
import { setAppState, useAppState } from "../store.ts";
import { newChat, switchConversation } from "../ws.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";

function shortTime(ts: number): string {
	const date = new Date(ts);
	const today = new Date();
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	return sameDay
		? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: date.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
}

/** 每个项目下最多显示几个会话（其余折叠成一行计数，避免侧栏被 91 个会话撑爆） */
const SESSIONS_PER_PROJECT = 5;

/** 我的会话（我们自己建的、可继续的） */
function OwnSessions({ conversations, activeId }: { conversations: ConversationMeta[]; activeId: string | null }) {
	if (conversations.length === 0) {
		return <div className="sidebar-empty">还没有会话。发一条消息就会自动建一个。</div>;
	}
	return (
		<>
			{[...conversations]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((conversation) => (
					<button
						type="button"
						key={conversation.id}
						className={`sidebar-item${conversation.id === activeId ? " sidebar-item-active" : ""}`}
						onClick={() => switchConversation(conversation.id)}
						title={`${conversation.workspace}\n${conversation.id}`}
					>
						<span className="sidebar-item-title">{conversation.title || "新对话"}</span>
						<span className="sidebar-item-meta">
							{conversation.messageCount} 条 · {shortTime(conversation.updatedAt)}
						</span>
					</button>
				))}
		</>
	);
}

/** 项目分组（pi 已有会话，只读；ADR-0021 §1） */
function PiProjects({ projects, activeId }: { projects: PiProject[]; activeId: string | null }) {
	if (projects.length === 0) return null;
	return (
		<>
			<div className="sidebar-section">
				pi 项目
				<span className="sidebar-section-tag">可继续</span>
			</div>
			{projects.map((project, index) => {
				const shown = project.sessions.slice(0, SESSIONS_PER_PROJECT);
				const rest = project.sessions.length - shown.length;
				return (
					<details className="proj" key={project.cwd || project.name} open={index === 0}>
						<summary className="proj-head" title={project.cwd || "（未知项目）"}>
							<span className="proj-name">{project.name}</span>
							<span className="proj-count">{project.sessions.length}</span>
						</summary>
						<div className="proj-body">
							{shown.map((session) => (
								<button
									type="button"
									className={`pi-row${session.id === activeId ? " pi-row-active" : ""}`}
									key={session.id}
									onClick={() => switchConversation(session.id)}
									title={`${session.cwd}\n${session.id}\n点开即载入该会话，可直接继续聊`}
								>
									<span className="pi-row-title">{session.title || "（无标题）"}</span>
									<span className="pi-row-time">{shortTime(session.updatedAt)}</span>
								</button>
							))}
							{rest > 0 ? <div className="pi-row pi-row-more">还有 {rest} 个…</div> : null}
						</div>
					</details>
				);
			})}
		</>
	);
}

/** 会话列表：我的会话 + pi 已有项目（按项目分组） */
export function Sidebar({
	conversations,
	activeId,
	piProjects,
}: {
	conversations: ConversationMeta[];
	activeId: string | null;
	piProjects: PiProject[];
}) {
	const { settingsOpen } = useAppState();

	return (
		<aside className="sidebar">
			<div className="sidebar-head">
				<span className="sidebar-title">会话</span>
				<button type="button" className="btn btn-new" onClick={newChat} title="在当前工作区新建会话">
					＋ 新建
				</button>
				<button
					type="button"
					className="btn btn-new"
					title="快捷短语等设置"
					onClick={() => setAppState({ settingsOpen: !settingsOpen })}
				>
					⚙
				</button>
			</div>
			{settingsOpen ? <SettingsPanel /> : null}
			<div className="sidebar-list">
				<OwnSessions conversations={conversations} activeId={activeId} />
				<PiProjects projects={piProjects} activeId={activeId} />
			</div>
		</aside>
	);
}
