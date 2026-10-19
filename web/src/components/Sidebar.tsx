import type { ConversationMeta, PiProject } from "../types.ts";
import { newChat, switchConversation } from "../ws.ts";
import { SidebarMenu } from "./SidebarMenu.tsx";

/** 相对时间（参考实现的风格：刚刚 / 5分 / 3小时 / 2天 / 1个月） */
function relativeTime(ts: number, now = Date.now()): string {
	const diff = Math.max(0, now - ts);
	const minute = 60_000;
	if (diff < minute) return "刚刚";
	if (diff < 60 * minute) return `${Math.floor(diff / minute)}分`;
	if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}小时`;
	const days = Math.floor(diff / (24 * 60 * minute));
	if (days < 30) return `${days}天`;
	const months = Math.floor(days / 30);
	return months < 12 ? `${months}个月` : `${Math.floor(months / 12)}年`;
}

/** 每个项目下最多显示几个会话（其余折叠成一行计数，避免侧栏被 91 个会话撑爆） */
const SESSIONS_PER_PROJECT = 5;

/**
 * 会话侧栏（ADR-0021 §1/§2）：**只有项目分组**，每个项目可展开/收起，
 * 组内是该项目的会话（标题 + 相对时间），当前会话左侧竖条高亮。
 *
 * 「本地刚建、还没被扫描到」的会话按 `workspace` 归到对应项目下（`pending`），
 * 所以新建会话会立刻出现在它所属的项目里。
 */
export function Sidebar({
	conversations,
	activeId,
	piProjects,
	onCollapse,
	runningConversationId = null,
}: {
	conversations: ConversationMeta[];
	activeId: string | null;
	piProjects: PiProject[];
	/** 提供时在标题栏显示「收起」按钮（‹） */
	onCollapse?: () => void;
	/** 正在跑的是哪个会话（不是当前选中）—— 那一行显示转圈 + 「运行中」 */
	runningConversationId?: string | null;
}) {
	// 把「本地待归档」的会话按 workspace 归组；workspace 不在已知项目里的，单独成组（避免新建的会话消失）
	const knownWorkspaces = new Set(piProjects.map((project) => project.cwd));
	const groups: PiProject[] = piProjects.map((project) => ({ ...project }));
	for (const conversation of conversations) {
		const workspace = conversation.workspace || "";
		let group = groups.find((item) => item.cwd === workspace);
		if (!group) {
			group = {
				cwd: workspace,
				name: workspace === "" ? "（未知项目）" : workspace.split("/").filter(Boolean).pop() || workspace,
				sessions: [],
			};
			groups.push(group);
		}
		if (group.sessions.some((session) => session.id === conversation.id)) continue;
		group.sessions = [
			{
				id: conversation.id,
				title: conversation.title || "新对话",
				startedAt: conversation.createdAt,
				updatedAt: conversation.updatedAt,
				cwd: workspace,
				model: null,
				sessionPath: "",
			},
			...group.sessions,
		];
	}
	// 项目顺序**必须稳定**：按「最新会话的创建时间」倒序（新项目在上），
	// 绝不能用 updatedAt —— 切会话 / 跑一轮都会把它顶起来，项目就会自己跳到最上面。
	const newestOf = (project: PiProject) =>
		project.sessions.reduce((max, session) => Math.max(max, session.startedAt), 0);
	groups.sort((a, b) => newestOf(b) - newestOf(a) || a.cwd.localeCompare(b.cwd));

	return (
		<aside className="sidebar">
			<div className="sidebar-head">
				<span className="sidebar-title">会话</span>
				<span className="topbar-spacer" />
				{onCollapse ? (
					<button type="button" className="btn btn-new" onClick={onCollapse} title="收起侧栏">
						‹
					</button>
				) : null}
				<button type="button" className="btn btn-new" onClick={() => newChat()} title="在当前工作区新建会话">
					＋ 新建
				</button>
			</div>

			<div className="sidebar-list">
				{groups.length === 0 ? <div className="sidebar-empty">还没有会话。发一条消息就会自动建一个。</div> : null}
				{groups.map((project, index) => {
					const shown = project.sessions.slice(0, SESSIONS_PER_PROJECT);
					const rest = project.sessions.length - shown.length;
					const hasActive = project.sessions.some((session) => session.id === activeId);
					const name = project.name || "（未知项目）";
					void knownWorkspaces;
					return (
						<details className="proj" key={project.cwd || name} open={index === 0 || hasActive}>
							<summary className="proj-head" title={`${project.cwd || "（未知项目）"}\n点「+」在这个项目下新建会话`}>
								<span className="proj-chevron" aria-hidden="true" />
								<span className="proj-name">{name}</span>
								<button
									type="button"
									className="proj-new"
									title="在这个项目下新建会话"
									onClick={(event) => {
										event.preventDefault(); // 别把 details 一起展开/收起
										event.stopPropagation();
										newChat(project.cwd);
									}}
								>
									+
								</button>
							</summary>
							<div className="proj-body">
								{shown.map((session) => (
									<button
										type="button"
										key={session.id}
										className={`pi-row${session.id === activeId ? " pi-row-active" : ""}`}
										onClick={() => switchConversation(session.id)}
										title={`${session.cwd}\n${session.id}`}
									>
										<span className="pi-row-title">{session.title || "（无标题）"}</span>
										{session.id === runningConversationId ? (
											<span className="pi-running" title="这个会话正在运行">
												<span className="pi-ring" aria-hidden="true" />
												运行中
											</span>
										) : (
											<span className="pi-row-time">{relativeTime(session.updatedAt)}</span>
										)}
									</button>
								))}
								{rest > 0 ? <div className="pi-row pi-row-more">还有 {rest} 个…</div> : null}
							</div>
						</details>
					);
				})}
			</div>
			<SidebarMenu />
		</aside>
	);
}
