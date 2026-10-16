import type { ConversationMeta } from "../types.ts";
import { newChat, switchConversation } from "../ws.ts";

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

/** 会话列表（M2）：新建、切换、看标题与消息数 */
export function Sidebar({ conversations, activeId }: { conversations: ConversationMeta[]; activeId: string | null }) {
	return (
		<aside className="sidebar">
			<div className="sidebar-head">
				<span className="sidebar-title">会话</span>
				<button type="button" className="btn btn-new" onClick={newChat} title="新建会话">
					＋ 新建
				</button>
			</div>
			<div className="sidebar-list">
				{conversations.length === 0 ? (
					<div className="sidebar-empty">还没有会话。发一条消息就会自动建一个。</div>
				) : null}
				{[...conversations]
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.map((conversation) => (
						<button
							type="button"
							key={conversation.id}
							className={`sidebar-item${conversation.id === activeId ? " sidebar-item-active" : ""}`}
							onClick={() => switchConversation(conversation.id)}
							title={conversation.id}
						>
							<span className="sidebar-item-title">{conversation.title || "新对话"}</span>
							<span className="sidebar-item-meta">
								{conversation.messageCount} 条 · {shortTime(conversation.updatedAt)}
							</span>
						</button>
					))}
			</div>
		</aside>
	);
}
