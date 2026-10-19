import { useState } from "react";
import { useSplitHeight } from "../use-split-height.ts";
import { useAppState } from "../store.ts";
import type { ConversationMeta, PiProject, ProjectPrefs } from "../types.ts";
import { sortProjects } from "../project-sort.ts";
import { newChat, setSettings, switchConversation } from "../ws.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { ArchivedSection } from "./ArchivedSection.tsx";
import { groupArchived, isProjectOpen } from "../archived-groups.ts";
import { SessionRow } from "./SessionRow.tsx";
import { SidebarFiles } from "./SidebarFiles.tsx";

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
	runningIds = [],
	onOpenTerminal,
	onOpenFiles,
	onOpenFile,
}: {
	conversations: ConversationMeta[];
	activeId: string | null;
	piProjects: PiProject[];
	/** 提供时在标题栏显示「收起」按钮（‹） */
	onCollapse?: () => void;
	/** 正在跑的会话 id（ADR-0030：可以同时有多个） */
	runningIds?: string[];
	/** 在指定目录打开终端（项目菜单「在终端中打开」） */
	onOpenTerminal?: (cwd: string) => void;
	/** 在应用内的文件面板打开这个项目 */
	onOpenFiles?: (cwd: string) => void;
	/** 点文件 → 打开预览（root 是该文件所属项目根） */
	onOpenFile?: (path: string, root: string) => void;
}) {
	const { snapshot } = useAppState();
	// 项目偏好来自 settings.json（ADR-0028）：置顶 / 顺序 / 别名都是服务端事实源
	const prefs: ProjectPrefs = snapshot?.settings.projectPrefs ?? { order: [], pinned: [], aliases: {} };
	const pinned = prefs.pinned;
	// 受控展开：菜单里的「折叠其他项目 / 展开全部」需要它
	const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	// 文件区默认收起（只有标题栏一行），点箭头展开
	const [fileOpen, setFileOpen] = useState(false);
	const [archivedView, setArchivedView] = useState(false);
	// 文件树根：默认跟随当前会话工作区，可从下拉框切到任意项目
	const [treeRoot, setTreeRoot] = useState<string | null>(null);
	const sessionPrefs = snapshot?.settings.sessionPrefs ?? { pinned: [], archived: [], titles: {} };
	const [sessionMenu, setSessionMenu] = useState<string | null>(null);
	const patchSessionPrefs = (patch: Partial<typeof sessionPrefs>) =>
		setSettings({ sessionPrefs: { ...sessionPrefs, ...patch } });
	const archivedGroups = groupArchived(piProjects, sessionPrefs);
	const currentRoot = snapshot?.files?.root ?? null;
	// 「还有 N 个…」点开后就显示全部（每个项目各自记）
	const [showAll, setShowAll] = useState<Record<string, boolean>>({});
	// 项目显示名（别名）：只改展示，不动 pi 的会话目录（ADR-0028：身份是 cwd）
	const aliases = prefs.aliases;
	const renameProject = (cwd: string, current: string) => {
		const next = window.prompt("项目显示名（只影响这里，不改目录）", current);
		if (next === null) return;
		setSettings({ projectPrefs: { ...prefs, aliases: { ...prefs.aliases, [cwd]: next.trim() } } });
	};

	/** 上移/下移：置顶段改 pinned 顺序，其余改 order 顺序（ADR-0028 §5） */
	const moveWithin = (cwd: string, direction: -1 | 1) => {
		const isPinned = pinned.includes(cwd);
		// order 还空时要先按「当前看到的顺序」播种，否则 indexOf 找不到 → 点了没反应
		const currentOrder = prefs.order.filter((item) => !pinned.includes(item));
		const seeded =
			currentOrder.length > 0
				? currentOrder
				: groups.filter((group) => !pinned.includes(group.cwd)).map((group) => group.cwd);
		const list = (isPinned ? pinned : seeded) as string[];
		const current = list.indexOf(cwd);
		const target = current + direction;
		if (current < 0 || target < 0 || target >= list.length) return;
		const next = [...list];
		next.splice(current, 1);
		next.splice(target, 0, cwd);
		setSettings({ projectPrefs: isPinned ? { ...prefs, pinned: next } : { ...prefs, order: next } });
	};

	const togglePin = (cwd: string) => {
		const next = pinned.includes(cwd) ? pinned.filter((item) => item !== cwd) : [cwd, ...pinned];
		setSettings({ projectPrefs: { ...prefs, pinned: next } });
	};

	// 会话区与文件区之间的分隔条（拖动改高度，存 localStorage）
	const split = useSplitHeight({ storageKey: "agent-web.side.filesHeight", initial: 260, min: 120 });

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
	// 排序统一走 ADR-0028 的纯函数：置顶 → 显式顺序 → 新项目落最上面
	groups.splice(0, groups.length, ...sortProjects(groups, prefs));
	// 头部箭头方向：所有项目当前都展开才算"已展开"
	const allOpen = groups.every((group, index) => isProjectOpen(group, index, openMap, activeId));

	return (
		<aside className="sidebar">
			<div className="sidebar-head">
				<button
					type="button"
					className="project-collapse-all"
					title={allOpen ? "收起所有项目" : "展开所有项目"}
					onClick={() => setOpenMap(Object.fromEntries(groups.map((group) => [group.cwd, !allOpen])))}
				>
					{allOpen ? "⌄" : "›"}
				</button>
				<span className="sidebar-title">项目（{groups.length}）</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-new"
					title="新建项目（选择一个本地目录）"
					onClick={() => setNewProjectOpen(true)}
				>
					📁＋
				</button>
				{onCollapse ? (
					<button type="button" className="btn btn-new" onClick={onCollapse} title="收起侧栏">
						‹
					</button>
				) : null}
			</div>

			<div className={`sidebar-list${archivedView ? " sidebar-list-hidden" : ""}`}>
				{groups.length === 0 ? <div className="sidebar-empty">还没有会话。发一条消息就会自动建一个。</div> : null}
				{groups.map((project, index) => {
					const expanded = showAll[project.cwd] === true;
					// 归档的会话从列表隐藏；置顶的排在该项目最前
					const visibleSessions = project.sessions
						.filter((session) => !sessionPrefs.archived.includes(session.id))
						.sort((a, b) => Number(sessionPrefs.pinned.includes(b.id)) - Number(sessionPrefs.pinned.includes(a.id)));
					const shown = expanded ? visibleSessions : visibleSessions.slice(0, SESSIONS_PER_PROJECT);
					const rest = visibleSessions.length - shown.length;
					const hasActive = project.sessions.some((session) => session.id === activeId);
					const name = aliases[project.cwd] || project.name || "（未知项目）";
					void knownWorkspaces;
					return (
						<details
							className="proj"
							key={project.cwd || name}
							open={menuFor === project.cwd ? true : (openMap[project.cwd] ?? (index === 0 || hasActive))}
							onToggle={(event) => {
								const next = (event.currentTarget as HTMLDetailsElement).open;
								setOpenMap((current) => ({ ...current, [project.cwd]: next }));
							}}
						>
							<summary className="proj-head" title={`${project.cwd || "（未知项目）"}\n点「+」在这个项目下新建会话`}>
								<span className="proj-chevron" aria-hidden="true" />
								<span className="proj-name">{name}</span>
								{pinned.includes(project.cwd) ? (
									<span className="proj-pin" title="已置顶" aria-label="已置顶">
										📌
									</span>
								) : null}
								<button
									type="button"
									className="proj-menu-btn"
									title="更多操作"
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										setMenuFor(menuFor === project.cwd ? null : project.cwd);
									}}
								>
									⋯
								</button>
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
							{menuFor === project.cwd ? (
								<div className="proj-menu" role="menu">
									<button
										type="button"
										className="proj-menu-item"
										onClick={() => {
											togglePin(project.cwd);
											setMenuFor(null);
										}}
									>
										{pinned.includes(project.cwd) ? "📌 取消置顶" : "📌 置顶项目"}
									</button>
									<button
										type="button"
										className="proj-menu-item"
										title="在同组内上移一格"
										onClick={() => {
											moveWithin(project.cwd, -1);
											setMenuFor(null);
										}}
									>
										↑ 上移
									</button>
									<button
										type="button"
										className="proj-menu-item"
										title="在同组内下移一格"
										onClick={() => {
											moveWithin(project.cwd, 1);
											setMenuFor(null);
										}}
									>
										↓ 下移
									</button>
									<button
										type="button"
										className="proj-menu-item"
										onClick={() => {
											renameProject(project.cwd, name);
											setMenuFor(null);
										}}
									>
										✏️ 重命名…
									</button>
									<button
										type="button"
										className="proj-menu-item"
										onClick={() => {
											onOpenFiles?.(project.cwd);
											setMenuFor(null);
										}}
									>
										📁 在文件列表中定位
									</button>
									<button
										type="button"
										className="proj-menu-item"
										onClick={() => {
											onOpenTerminal?.(project.cwd);
											setMenuFor(null);
										}}
									>
										⌨ 在终端中打开
									</button>
									<button
										type="button"
										className="proj-menu-item"
										title="在系统文件管理器里定位这个目录（只定位，不执行任何文件）"
										onClick={() => {
											void fetch("/api/projects/reveal", {
												method: "POST",
												headers: { "content-type": "application/json" },
												body: JSON.stringify({ cwd: project.cwd }),
											});
											setMenuFor(null);
										}}
									>
										🔍 在 Finder 中显示
									</button>
								</div>
							) : null}
							<div className="proj-body">
								{shown.map((session) => (
									<SessionRow
										key={session.id}
										session={session}
										active={session.id === activeId}
										running={runningIds.includes(session.id)}
										title={sessionPrefs.titles[session.id] ?? (session.title || "（无标题）")}
										pinned={sessionPrefs.pinned.includes(session.id)}
										menuOpen={sessionMenu === session.id}
										onToggleMenu={() => setSessionMenu(sessionMenu === session.id ? null : session.id)}
										onSwitch={() => switchConversation(session.id)}
										onPin={() =>
											patchSessionPrefs({
												pinned: sessionPrefs.pinned.includes(session.id)
													? sessionPrefs.pinned.filter((id) => id !== session.id)
													: [...sessionPrefs.pinned, session.id],
											})
										}
										onRename={() => {
											const next = window.prompt("会话显示名", sessionPrefs.titles[session.id] ?? session.title ?? "");
											if (next === null) return;
											patchSessionPrefs({ titles: { ...sessionPrefs.titles, [session.id]: next.trim() } });
										}}
										onArchive={() => patchSessionPrefs({ archived: [...sessionPrefs.archived, session.id] })}
										onCloseMenu={() => setSessionMenu(null)}
									/>
								))}
								{rest > 0 ? (
									<button
										type="button"
										className="pi-row pi-row-more"
										title={expanded ? "收起，只显示前几个" : `展开，显示全部 ${project.sessions.length} 个会话`}
										onClick={() => setShowAll((current) => ({ ...current, [project.cwd]: !expanded }))}
									>
										{expanded ? "收起" : `还有 ${rest} 个…`}
									</button>
								) : expanded && project.sessions.length > SESSIONS_PER_PROJECT ? (
									<button
										type="button"
										className="pi-row pi-row-more"
										onClick={() => setShowAll((current) => ({ ...current, [project.cwd]: false }))}
									>
										收起
									</button>
								) : null}
							</div>
						</details>
					);
				})}
			</div>
			<ArchivedSection
				groups={archivedGroups}
				view={archivedView}
				onEnter={() => setArchivedView(true)}
				onBack={() => setArchivedView(false)}
				onOpen={(id) => {
					void switchConversation(id);
					setArchivedView(false);
				}}
				onRestore={(id) => patchSessionPrefs({ archived: sessionPrefs.archived.filter((item) => item !== id) })}
			/>
			{/* 分隔条：按住上下拖 = 改文件区高度 */}
			{fileOpen && !archivedView ? (
				<div
					className="side-split"
					role="separator"
					aria-orientation="horizontal"
					title="拖动调整文件区高度（双击复位）"
					onPointerDown={split.start}
					onDoubleClick={split.reset}
				/>
			) : null}
			{archivedView ? null : (
				<SidebarFiles
					open={fileOpen}
					onToggle={() => setFileOpen((open) => !open)}
					height={split.height}
					root={treeRoot ?? currentRoot ?? null}
					onRootChange={setTreeRoot}
					options={groups.map((project) => ({
						cwd: project.cwd,
						label: aliases[project.cwd] || project.name || project.cwd,
					}))}
					onOpenFile={(path) => onOpenFile?.(path, treeRoot ?? currentRoot ?? "")}
					onOpenTerminal={() => {
						const target = treeRoot ?? currentRoot;
						if (target) onOpenTerminal?.(target);
					}}
				/>
			)}

			{newProjectOpen ? <NewProjectDialog onClose={() => setNewProjectOpen(false)} /> : null}
		</aside>
	);
}
