import { useState } from "react";
import { useSplitHeight } from "../use-split-height.ts";
import { useAppState } from "../store.ts";
import type { ConversationMeta, PiProject, ProjectPrefs } from "../types.ts";
import { sortProjects } from "../project-sort.ts";
import { newChat, renameSession, setSettings, switchConversation } from "../ws.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { ArchivedEntryButton } from "./ArchivedEntryButton.tsx";
import { ArchivedSection } from "./ArchivedSection.tsx";
import { groupArchived, isProjectOpen } from "../archived-groups.ts";
import { deleteSession, deleteSessions } from "../delete-session.ts";
import { sessionUrlFor } from "../session-url.ts";
import { SessionRow } from "./SessionRow.tsx";
import { ProjectFolderIcon } from "./ProjectFolderIcon.tsx";
import { ProjectNameInput } from "./ProjectNameInput.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";
import type { MenuPoint } from "./ProjectMenuPopover.tsx";
import { SideSplitter } from "./SideSplitter.tsx";
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
	runningIds = [],
	onOpenTerminal,
	onOpenFile,
}: {
	conversations: ConversationMeta[];
	activeId: string | null;
	piProjects: PiProject[];
	/** 正在跑的会话 id（ADR-0030：可以同时有多个） */
	runningIds?: string[];
	/** 在指定目录打开终端（项目菜单「在终端中打开」） */
	onOpenTerminal?: (cwd: string) => void;
	/** 点文件 → 打开预览（root 是该文件所属项目根） */
	onOpenFile?: (path: string, root: string) => void;
}) {
	const { snapshot } = useAppState();
	// 项目偏好来自 settings.json（ADR-0028）：置顶 / 顺序 / 别名都是服务端事实源
	const prefs: ProjectPrefs = snapshot?.settings.projectPrefs ?? { order: [], pinned: [], aliases: {} };
	const pinned = prefs.pinned;
	// 受控展开：菜单里的「折叠其他项目 / 展开全部」需要它
	const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
	/** 项目右键菜单：记录是哪个项目 + 从哪儿（鼠标位置）弹出来 */
	const [projectMenu, setProjectMenu] = useState<{ cwd: string; point: MenuPoint } | null>(null);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	// 文件区默认收起（只有标题栏一行），点箭头展开
	const [fileOpen, setFileOpen] = useState(false);
	const [archivedView, setArchivedView] = useState(false);
	// 文件树根：默认跟随当前会话工作区，可从下拉框切到任意项目
	const [treeRoot, setTreeRoot] = useState<string | null>(null);
	const sessionPrefs = snapshot?.settings.sessionPrefs ?? { pinned: [], archived: [] };
	/** 会话右键菜单：同上，记录会话 id + 鼠标位置 */
	const [sessionMenu, setSessionMenu] = useState<{ id: string; point: MenuPoint } | null>(null);
	const patchSessionPrefs = (patch: Partial<typeof sessionPrefs>) =>
		setSettings({ sessionPrefs: { ...sessionPrefs, ...patch } });
	const archivedGroups = groupArchived(piProjects, sessionPrefs);
	/** 归档总数（标题栏那个 🗄 入口的显示条件与提示） */
	const archivedTotal = archivedGroups.reduce((sum, group) => sum + group.items.length, 0);
	const currentRoot = snapshot?.files?.root ?? null;
	// 「还有 N 个…」点开后就显示全部（每个项目各自记）
	const [showAll, setShowAll] = useState<Record<string, boolean>>({});
	// 项目显示名（别名）：只改展示，不动 pi 的会话目录（ADR-0028：身份是 cwd）
	const aliases = prefs.aliases;
	/** 正在就地改名的项目（cwd + 草稿）—— 不用 window.prompt：它会被某些环境吞掉 */
	const [renaming, setRenaming] = useState<{ cwd: string; draft: string } | null>(null);
	const commitRename = () => {
		if (!renaming) return;
		const next = renaming.draft.replace(/\s+/g, " ").trim();
		const aliasesNext = { ...prefs.aliases };
		if (next === "") delete aliasesNext[renaming.cwd];
		else aliasesNext[renaming.cwd] = next;
		setSettings({ projectPrefs: { ...prefs, aliases: aliasesNext } });
		setRenaming(null);
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

	// 文件区默认高度：矮一点，「文件管理」标题离底部（文件树占的地方）更近；拖过的人按自己存的来
	const split = useSplitHeight({
		storageKey: "agent-web.side.filesHeight",
		initial: 200,
		min: 120,
		legacyDefaults: [260],
	});

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
	// 展开态只算一处：标题的「全部收起/展开」、<details open>、文件夹图标都用它（否则点一下会「看着没变」）
	const isOpenAt = (project: PiProject, index: number) =>
		projectMenu?.cwd === project.cwd || isProjectOpen(project, index, openMap, activeId);
	const allOpen = groups.every((project, index) => isOpenAt(project, index));
	/** 点「项目（N）」标题：一次把下面所有项目设成同一个开合状态 */
	const toggleAllProjects = () => setOpenMap(Object.fromEntries(groups.map((group) => [group.cwd, !allOpen])));

	return (
		<aside className="sidebar">
			<div className="sidebar-head">
				{/* 标题本身就是开关：点一下收起下面所有项目，再点一下全部展开 */}
				<button
					type="button"
					className="sidebar-title"
					title={allOpen ? "收起所有项目" : "展开所有项目"}
					aria-expanded={allOpen}
					onClick={toggleAllProjects}
				>
					项目（{groups.length}）
				</button>
				{/* 紧跟标题的「＋」：新建项目（只留一个加号，不要文件夹图标） */}
				<button
					type="button"
					className="btn btn-new"
					title="新建项目（选择一个本地目录）"
					onClick={() => setNewProjectOpen(true)}
				>
					+
				</button>
				<ArchivedEntryButton total={archivedTotal} active={archivedView} onToggle={() => setArchivedView((v) => !v)} />
				<span className="topbar-spacer" />
			</div>

			<div className={`sidebar-list${archivedView ? " sidebar-list-hidden" : ""}`}>
				{groups.length === 0 ? <div className="sidebar-empty">还没有会话。发一条消息就会自动建一个。</div> : null}
				{groups.map((project, index) => {
					const expanded = showAll[project.cwd] === true;
					// 归档的会话从列表隐藏；置顶的排在该项目最前
					// 排序只由「置顶 + 创建时间」决定：会话被更新不该换位置（列表一跳就很难点）
					const pinnedRank = (id: string) => Number(sessionPrefs.pinned.includes(id));
					const visibleSessions = project.sessions
						.filter((session) => !sessionPrefs.archived.includes(session.id))
						.sort((a, b) => pinnedRank(b.id) - pinnedRank(a.id) || b.startedAt - a.startedAt);
					const shown = expanded ? visibleSessions : visibleSessions.slice(0, SESSIONS_PER_PROJECT);
					const rest = visibleSessions.length - shown.length;
					const name = aliases[project.cwd] || project.name || "（未知项目）";
					const projectOpen = isOpenAt(project, index);
					void knownWorkspaces;
					return (
						<details
							className="proj"
							key={project.cwd || name}
							open={projectOpen}
							onToggle={(event) => {
								const next = (event.currentTarget as HTMLDetailsElement).open;
								setOpenMap((current) => ({ ...current, [project.cwd]: next }));
							}}
						>
							<summary
								className="proj-head"
								title={`${project.cwd || "（未知项目）"}\n右键：项目菜单　点「+」：在这里新建会话`}
								onContextMenu={(event) => {
									// 右键 = 项目菜单（原来那个「⋯」按钮已经去掉）
									event.preventDefault();
									event.stopPropagation();
									setProjectMenu({ cwd: project.cwd, point: { x: event.clientX, y: event.clientY } });
								}}
								onClick={(event) => {
									// 正在改名时点这一行不要展开/收起（否则输入框会被卸载）
									if (renaming?.cwd === project.cwd) event.preventDefault();
								}}
							>
								<ProjectFolderIcon open={projectOpen} />
								{renaming?.cwd === project.cwd ? (
									<ProjectNameInput
										value={renaming.draft}
										onChange={(next) => setRenaming({ cwd: project.cwd, draft: next })}
										onCommit={commitRename}
										onCancel={() => setRenaming(null)}
									/>
								) : (
									// 不改名的话就是纯文字：项目名**没有双击改名**，改名走菜单（右键 / ＋）
									<span className="proj-name">{name}</span>
								)}
								{pinned.includes(project.cwd) ? (
									<span className="proj-pin" title="已置顶" aria-label="已置顶">
										📌
									</span>
								) : null}
								<button
									type="button"
									className="proj-more"
									title="项目菜单（新建会话 / 重命名 / 定位…）"
									onClick={(event) => {
										event.preventDefault(); // 别把 details 一起展开/收起
										event.stopPropagation();
										// 和右键同一张菜单：从这一行的右下角弹出来
										const rect = event.currentTarget.getBoundingClientRect();
										setProjectMenu({ cwd: project.cwd, point: { x: rect.left, y: rect.bottom + 2 } });
									}}
								>
									⋯
								</button>
							</summary>
							{projectMenu?.cwd === project.cwd ? (
								<ProjectMenu
									point={projectMenu.point}
									onClose={() => setProjectMenu(null)}
									pinned={pinned.includes(project.cwd)}
									onTogglePin={() => togglePin(project.cwd)}
									onNewSession={() => newChat(project.cwd)}
									onMoveUp={() => moveWithin(project.cwd, -1)}
									onMoveDown={() => moveWithin(project.cwd, 1)}
									onRename={() => setRenaming({ cwd: project.cwd, draft: name })}
									onOpenFiles={() => {
										// 定位 = 文件区打开 + 根切到这个项目（还能在下面的下拉框里再换）
										setTreeRoot(project.cwd);
										setFileOpen(true);
									}}
									onOpenTerminal={() => onOpenTerminal?.(project.cwd)}
									onReveal={() =>
										void fetch("/api/projects/reveal", {
											method: "POST",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ cwd: project.cwd }),
										})
									}
									onDeleteAll={() =>
										deleteSessions(
											project.sessions.map((item) => item.id),
											`「${name}」下的全部会话`,
										)
									}
									sessionCount={project.sessions.length}
								/>
							) : null}
							<div className="proj-body">
								{shown.map((session) => (
									<SessionRow
										key={session.id}
										session={session}
										active={session.id === activeId}
										running={runningIds.includes(session.id)}
										title={session.title || "（无标题）"}
										pinned={sessionPrefs.pinned.includes(session.id)}
										menuPoint={sessionMenu?.id === session.id ? sessionMenu.point : null}
										onOpenMenu={(point) => setSessionMenu({ id: session.id, point })}
										onSwitch={() => switchConversation(session.id)}
										onPin={() =>
											patchSessionPrefs({
												pinned: sessionPrefs.pinned.includes(session.id)
													? sessionPrefs.pinned.filter((id) => id !== session.id)
													: [...sessionPrefs.pinned, session.id],
											})
										}
										onRename={(next) => {
											// 就地编辑提交：名字写进 pi 的会话文件（session_info），不弹窗
											renameSession(session.id, next);
										}}
										onArchive={() => patchSessionPrefs({ archived: [...sessionPrefs.archived, session.id] })}
										onOpenInNewTab={() =>
											window.open(sessionUrlFor(window.location.href, session.id), "_blank", "noopener")
										}
										onDelete={() => deleteSession(session.id, session.title ?? session.id)}
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
				onBack={() => setArchivedView(false)}
				onOpen={(id) => {
					void switchConversation(id);
					setArchivedView(false);
				}}
				onRestore={(id) => patchSessionPrefs({ archived: sessionPrefs.archived.filter((item) => item !== id) })}
				onRestoreMany={(ids) => {
					// 一次算完再发：批量恢复不能逐条发（每条都基于旧列表，服务端整表覆盖 → 只剩一条生效）
					const drop = new Set(ids);
					patchSessionPrefs({ archived: sessionPrefs.archived.filter((item) => !drop.has(item)) });
				}}
			/>
			{archivedView ? null : (
				<SideSplitter open={fileOpen} onOpen={() => setFileOpen(true)} onStart={split.start} onReset={split.reset} />
			)}
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
					// 在 Finder 中显示：复用项目菜单那条后端接口（只定位，不执行文件）
					onReveal={(cwd) =>
						void fetch("/api/projects/reveal", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ cwd }),
						})
					}
				/>
			)}

			{newProjectOpen ? <NewProjectDialog onClose={() => setNewProjectOpen(false)} /> : null}
		</aside>
	);
}
