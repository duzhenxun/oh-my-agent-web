import { useEffect, useRef, useState } from "react";
import { normalizeCwd } from "../path-utils.ts";
import { buildProjectGroups } from "../project-groups.ts";
import { useSplitHeight } from "../use-split-height.ts";
import { useAppState } from "../store.ts";
import type { ConversationMeta, PiProject, PiSessionSummary, ProjectPrefs } from "../types.ts";
import { reorderProjects, sortProjects } from "../project-sort.ts";
import { moveSession, renameSession, setSettings, switchConversation } from "../ws.ts";
import { ArchivedEntryRow } from "./ArchivedEntryRow.tsx";
import { ArchivedSection } from "./ArchivedSection.tsx";
import { SessionBatchMenu } from "./SessionBatchMenu.tsx";
import { SessionSelectionBar } from "./SessionSelectionBar.tsx";
import { groupArchived, isProjectOpen } from "../archived-groups.ts";
import { deleteSession, deleteSessions } from "../delete-session.ts";
import { showToast } from "../toast.ts";
import { getAppState, startNewSession } from "../store.ts";
import { sessionUrlFor } from "../session-url.ts";
import { SessionRow } from "./SessionRow.tsx";
import { FolderPlusIcon } from "./FolderIcon.tsx";
import { ProjectFolderIcon } from "./ProjectFolderIcon.tsx";
import { ProjectNameInput } from "./ProjectNameInput.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";
import type { MenuPoint } from "./ProjectMenuPopover.tsx";
import { SideSplitter } from "./SideSplitter.tsx";
import { SidebarFiles } from "./SidebarFiles.tsx";
import { NewChatButton } from "./NewChatButton.tsx";
import { useT } from "../use-language.ts";
import { useStoredNumber } from "../use-stored-number.ts";
import {
	SESSIONS_PER_PROJECT_DEFAULT,
	SESSIONS_PER_PROJECT_KEY,
	SESSIONS_PER_PROJECT_MAX,
	SESSIONS_PER_PROJECT_MIN,
} from "../ui-prefs.ts";
// 「跑完了、你还没看」的圆点（存 localStorage；判定在 App 里的 useUnseenFinishWatch）
import { clearUnseen, clearUnseenMany } from "../session-unseen.ts";
import { useUnseenMarks } from "../use-unseen-finish.ts";
// 会话的手动顺序（拖动排序）：「手动动过的按位置排，其余按创建时间」——纯函数在 session-order.ts
import { insertBefore, rankSessions, withProjectOrder, withSessionFirst } from "../session-order.ts";
// 多选（Shift 连选 / Ctrl·⌘ 加减选）的算术 —— 纯函数在 session-selection.ts
import { pruneSelection, rangeSelection, toggleSelection } from "../session-selection.ts";

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
	onSearchContents,
	fileOpen: fileOpenProp,
	onFileOpenChange,
	/** 「＋ 新建项目」：对话框由 App 画（快捷键也要能开它，而侧栏收起时整个 Sidebar 是不挂载的） */
	onNewProject,
	/** 顶栏被藏起来了没有（「新会话」平时在顶栏，藏起来时回落到这一行里画一颗） */
	appbarHidden = false,
	root,
	onRootChange,
	activePath,
	revealSeq,
	revealPath,
	onRevealPath,
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
	/** 文件管理标题栏的「搜文件内容」：开全文搜索浮层（浮层挂在 App 上） */
	onSearchContents?: () => void;
	/**
	 * 文件树的根（＝「文件 ▾」下拉框选中的那个项目），`null` = 跟随当前会话工作区。
	 * **由 App 持有**：全文搜索浮层要跟它走 —— 下拉框选了哪个项目，就只在那个项目里搜
	 * （以前浮层自己取会话工作区，于是「选了 A 项目却搜出 B 项目的行」）。
	 */
	root: string | null;
	onRootChange: (cwd: string | null) => void;
	/** 预览面板里正在看的那个文件（相对它自己的项目根）：左树也把它选上，左右两边“说的是同一个文件” */
	activePath?: string | null;
	/** 变化一次 = 把 `activePath` 在左树里定位出来（展开祖先目录 + 滚进视野） */
	revealSeq?: number;
	/** 定位目标（默认跟 `activePath` 走）：文件名搜索点了目录时那个目录 */
	revealPath?: string | null;
	/** 请外面「在左树里定位这个路径」（加一次 revealSeq），点搜索结果的目录时用 */
	onRevealPath?: (path: string) => void;
	/**
	 * 「文件管理」展开着没有（受控）：右侧工具落地页那张「文件」卡要能把它打开，
	 * 所以状态放在 App；不传就退回组件内部自己管（老的调用方式照旧能用）。
	 */
	fileOpen?: boolean;
	onFileOpenChange?: React.Dispatch<React.SetStateAction<boolean>>;
	onNewProject: () => void;
	/**
	 * 顶栏是否被藏起来（状态栏那颗 ▴/▾）。
	 * 「新会话」**默认在顶栏**（用户要求：放到顶部，跟侧栏收起时那颗同一个位置）；
	 * 只有顶栏整条不画时才在这里补一颗，否则同一屏会出现两份。
	 */
	appbarHidden?: boolean;
}) {
	const t = useT();
	const { snapshot } = useAppState();
	// 每个项目默认展示几条会话：设置 → 界面 → 侧栏能改（默认 10），改完立刻生效
	const [sessionsPerProject] = useStoredNumber(
		SESSIONS_PER_PROJECT_KEY,
		SESSIONS_PER_PROJECT_DEFAULT,
		SESSIONS_PER_PROJECT_MIN,
		SESSIONS_PER_PROJECT_MAX,
	);
	// 跑完了、还没点开看过的会话（会话行 / 项目行上的小蓝点）
	const unseen = useUnseenMarks();
	// 项目偏好来自 settings.json（ADR-0028）：置顶 / 顺序 / 别名都是服务端事实源
	const rawPrefs: ProjectPrefs = snapshot?.settings.projectPrefs ?? { order: [], pinned: [], aliases: {} };
	/**
	 * 旧数据里的项目 key 可能带着尾斜杠（`/a/b/`，见 `normalizeCwd` 的注释），
	 * 而分组后的 cwd 是干净的 `/a/b` —— 不归一化的话「置顶 / 顺序 / 别名」会全部对不上号
	 * （表现就是：明明置顶过，却掉回下面那一段）。读的时候收敛一下，写回去的就是干净的。
	 */
	const prefs: ProjectPrefs = {
		order: rawPrefs.order.map(normalizeCwd),
		pinned: rawPrefs.pinned.map(normalizeCwd),
		aliases: Object.fromEntries(Object.entries(rawPrefs.aliases).map(([cwd, name]) => [normalizeCwd(cwd), name])),
	};
	const pinned = prefs.pinned;
	// 受控展开：菜单里的「折叠其他项目 / 展开全部」需要它
	const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
	/**
	 * 刚才那一下按的是不是**非左键**（右键 / 中键）—— 用来压掉「右键顺便把项目展开」。
	 *
	 * 实测（Chromium）：`<details>` 的折叠是在 **mouseup** 那一刻切的，而且**不分按键** ——
	 * 所以右键项目行时，`contextmenu` 之后紧跟着一次 `mouseup`，项目就被展开了。
	 * 表现就是「只想开菜单，结果项目也被摊开」（用户 2026-10-29 报的）。
	 * 这里在按下时记一笔时间，`onToggle` 里发现是刚刚那次非左键按的，就把 DOM 改回去、也不写进 openMap。
	 */
	const nonPrimaryPressAt = useRef(0);
	/**
	 * 长按项目行 = 项目菜单（触摸屏上的「右键」）。
	 *
	 * 为什么需要它：手机版把行尾那颗「⋯」**收掉了**（用户 2026-10-30：「项目上面还有」——
	 * 会话行已经没那三个点和方框了，项目行也要一样）。iOS 上 `contextmenu` 靠不住
	 * （长按一个普通元素不一定派发），所以自己数秒：按住 450ms 弹同一张菜单。
	 *
	 * `opened` 是「这次长按真的开过菜单」的记号 —— 长按松手后浏览器还会补一次 `click`，
	 * 那个 click 会把项目折叠/展开（`<summary>` 的默认行为），要在这里吞掉。
	 */
	const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
	const longPressOpened = useRef(false);
	/** 停掉计时器（指针抬起 / 移开 / 被系统打断都要调） */
	const cancelLongPress = () => {
		if (longPress.current === null) return;
		window.clearTimeout(longPress.current.timer);
		longPress.current = null;
	};
	/** 项目右键菜单：记录是哪个项目 + 从哪儿（鼠标位置）弹出来 */
	const [projectMenu, setProjectMenu] = useState<{
		cwd: string;
		point: MenuPoint;
		/** 触发它的那一行（`.proj-head`）：浮窗的小尾巴指着它 */
		anchor: HTMLElement | null;
	} | null>(null);
	// 文件区默认收起（只有标题栏一行），点箭头展开；外部（工具落地页的「文件」卡）也能打开它
	const [fileOpenLocal, setFileOpenLocal] = useState(false);
	const fileOpen = fileOpenProp ?? fileOpenLocal;
	const setFileOpen = onFileOpenChange ?? setFileOpenLocal;
	/**
	 * 「项目」这一整块（所有项目 + 会话）是否展开。
	 * 跟下面的「文件管理」同一个套路：点标题收起/展开整块。
	 * 以前点标题是「把所有项目各自展开/收起」—— 那是另一个动作，现在挪到标题右边的图标上。
	 */
	const [projectsOpen, setProjectsOpen] = useState(true);
	const [archivedView, setArchivedView] = useState(false);
	/**
	 * 文件区被**外部**打开时（右侧工具落地页那张「文件」卡）先把「已归档」视图切回来：
	 * 那个视图里整块文件管理是不渲染的，不切回去就等于点了没反应。
	 */
	useEffect(() => {
		if (fileOpen) setArchivedView(false);
	}, [fileOpen]);
	// 文件树根默认跟随当前会话工作区（下拉框里选了项目时由 App 那边的 `root` 接管）
	const sessionPrefs = snapshot?.settings.sessionPrefs ?? { pinned: [], archived: [], order: [] };
	/** 「置顶」那个分组是否展开（默认展开：置顶本来就是最常用的几条） */
	const [pinnedOpen, setPinnedOpen] = useState(true);
	/** 会话右键菜单：同上，记录会话 id + 鼠标位置 */
	const [sessionMenu, setSessionMenu] = useState<{ id: string; point: MenuPoint } | null>(null);
	/**
	 * 多选（用户 2026-10-29：「Shift 连选一批 / Ctrl 加选几个，右键批量删除、批量归档」）。
	 *
	 * 存**数组**而不是 Set：Shift 连选要按「看得见的顺序」切一段，锚点也得能落回去。
	 * 普通点击**不**往这里写（它只清空）：否则刚点开的会话永远带着一块选中底色，
	 * 跟 `pi-row-active` 叠在一起看不出到底哪个是「当前会话」。
	 */
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	/** Shift 连选的锚点（最后一次**不带修饰键**点到的会话；Ctrl·⌘ 点的也会成为新锚点） */
	const selectAnchor = useRef<string | null>(null);
	/** 批量菜单：浮在右键位置（它不属于某一行，而属于那一片选区） */
	const [batchMenu, setBatchMenu] = useState<{ point: MenuPoint } | null>(null);
	/**
	 * 拖动状态（把会话拖到别的项目 / 在项目内拖动互换位置）。
	 * 存成 React state 而不是只靠 dataTransfer：dataTransfer.getData 在 dragover 里拿不到内容，
	 * 而高亮「拖到哪儿」恰好需要在 dragover 阶段读源信息。
	 */
	const [drag, setDrag] = useState<{ id: string; cwd: string } | null>(null);
	/** 正被拖到哪个项目（给项目行加高亮） */
	const [dragOverCwd, setDragOverCwd] = useState<string | null>(null);
	/** 正被拖到哪条会话（给会话行加「插到它前面」的高亮） */
	const [dragOverSession, setDragOverSession] = useState<string | null>(null);
	/**
	 * 拖动的是哪个**项目**（改项目顺序）。
	 *
	 * 跟上面那条会话拖动 `drag` 分开存：两者落点规矩完全不一样 ——
	 * 拖会话 = 「搬到哪个项目 / 插到哪条前面」；拖项目 = 「插到别的项目前/后」。
	 * 混用一个状态就得在每个 dragover 里猜，猜错一次就是「拖了一下，会话莫名搬了家」。
	 */
	const [projDrag, setProjDrag] = useState<string | null>(null);
	/** 拖到哪一行上、落在它前面还是后面（落点那条强调色插入线） */
	const [projDrop, setProjDrop] = useState<{ cwd: string; after: boolean } | null>(null);
	/**
	 * 会话偏好是**整表覆盖**写的：一律先读最新一份再改。
	 *
	 * 用闭包里那份 `sessionPrefs` 的后果实测过：新建会话刚把自己的 id 写进 `order`，
	 * 只要之前渲染的那一帧还没收到新快照，紧接着一次「置顶 / 归档 / 批量还原」就会把它冲掉，
	 * 于是新会话沉到列表底下（用户报的「新建的会话要放在当前项目最顶上才对」）。
	 */
	const latestSessionPrefs = () => getAppState().snapshot?.settings.sessionPrefs ?? sessionPrefs;
	const patchSessionPrefs = (patch: Partial<typeof sessionPrefs>) =>
		setSettings({ sessionPrefs: { ...latestSessionPrefs(), ...patch } });
	/**
	 * 归档一条会话 + 弹一条可撤销的提示。
	 *
	 * 为什么要读「最新的」设置而不是用闭包里那份：连着归档两条时，第二个回调里的
	 * `sessionPrefs` 还是第一次归档之前的（服务端是整表覆盖），会把前一条又放出来。
	 * 提示里给「撤销」（就地还原）和「查看」（跳到归档视图），误点一下不至于找不回来。
	 */
	const archiveSession = (id: string, title: string) => {
		const latest = latestSessionPrefs();
		if (latest.archived.includes(id)) return;
		setSettings({ sessionPrefs: { ...latest, archived: [...latest.archived, id] } });
		showToast({
			text: t(`已归档「${title || "未命名会话"}」`, `Archived "${title || "Untitled session"}"`),
			actions: [
				{ label: t("撤销", "Undo"), onClick: () => restoreSession(id) },
				{ label: t("查看", "View"), onClick: () => setArchivedView(true) },
			],
		});
	};

	/** 从归档里还原一条（同样读最新设置） */
	const restoreSession = (id: string) => {
		const latest = latestSessionPrefs();
		if (!latest.archived.includes(id)) return;
		setSettings({ sessionPrefs: { ...latest, archived: latest.archived.filter((each) => each !== id) } });
	};
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

	/**
	 * 指针落在 `listEl` 里的哪个项目上、插到它前还是后；null = 没有可落的项目。
	 *
	 * 量的是**表头**（`.proj-head`）而不是整块 `<details>`：展开的项目块有好几百像素高，
	 * 拿整块算中线，「落在它下半部分」就永远等于「插到它后面」，想插到它前面反而点不到。
	 */
	const projectDropAt = (listEl: HTMLElement, pointerY: number): { cwd: string; after: boolean } | null => {
		const blocks = [...listEl.querySelectorAll<HTMLElement>("details.proj[data-cwd]")];
		let last: { cwd: string; after: boolean } | null = null;
		for (const block of blocks) {
			const cwd = block.dataset.cwd ?? "";
			if (cwd === "" || cwd === projDrag) continue;
			const head = block.querySelector<HTMLElement>(".proj-head") ?? block;
			const rect = head.getBoundingClientRect();
			last = { cwd, after: true };
			if (pointerY < rect.top + rect.height / 2) return { cwd, after: false };
		}
		return last;
	};

	/**
	 * 拖动改项目顺序：把 `fromCwd` 插到 `targetCwd` 的前面 / 后面。
	 * 怎么算、跨置顶段怎么处理都写在 `project-sort.ts` 的 `reorderProjects` 里（纯函数）。
	 */
	const moveProjectTo = (fromCwd: string, targetCwd: string, after: boolean) => {
		const next = reorderProjects({
			visible: groups.map((group) => group.cwd),
			pinned,
			from: fromCwd,
			target: targetCwd,
			after,
		});
		if (!next) return;
		setSettings({ projectPrefs: { ...prefs, ...next } });
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
	const knownWorkspaces = new Set(piProjects.map((project) => project.cwd)); /**
	 * 会话标题：**跟顶栏那个标题用同一份来源**（用户报的 bug：新会话建好后，
	 * 上面写着首条消息，左边却写着「2026/10/28 16:57:51」）。
	 *
	 * 为什么两处会不一样：顶栏用服务端内存里的 `conversations[].title`（建会话 / 首条消息时就写），
	 * 而这一栏用的是 pi 会话文件扫出来的标题 —— 那份要等文件落盘、且真能读到首条消息才有，
	 * 读不到就退化成文件修改时间。所以只要本地有这条会话（本进程建的、或重命名过），
	 * 就以它为准；扫盘那份只当「本进程没见过这条会话」时的兵底（历史会话、别的客户端建的）。
	 */
	const localTitles = new Map(
		conversations
			.filter((conversation) => conversation.title !== "")
			.map((conversation) => [conversation.id, conversation.title]),
	);
	const titleOf = (session: { id: string; title: string }): string => localTitles.get(session.id) || session.title;
	/**
	 * 项目 + 会话的合成走 `project-groups.ts`（纯函数）。
	 *
	 * 为什么不再在这里 `groups.find(item => item.cwd === workspace)`：那个「字符串全等」是
	 * 用户报的「新建项目出来两个」的根源 —— 同一条会话的 workspace（`/a/b/`，带尾斜杠）
	 * 与 pi 扫出来的 cwd（`/a/b`）不相等，于是同一个项目被画成两组。
	 */
	const groups: PiProject[] = buildProjectGroups(piProjects, conversations, t("未分组", "Ungrouped"));
	// 排序统一走 ADR-0028 的纯函数：置顶 → 显式顺序 → 新项目落最上面
	groups.splice(0, groups.length, ...sortProjects(groups, prefs));
	// 头部箭头方向：所有项目当前都展开才算"已展开"
	// 展开态只算一处：标题的「全部收起/展开」、<details open>、文件夹图标都用它（否则点一下会「看着没变」）
	/**
	 * 这个项目是开着的吗 —— **只看用户自己的开合状态**。
	 *
	 * 以前这里还带着一条 `projectMenu?.cwd === project.cwd || ...`：右键打开菜单顺带把项目展开。
	 * 用户 2026-10-29 明确不要这个：「项目还折叠着的时候点右键，不要自动把折叠打开」——
	 * 只想看菜单，不想顺手把会话都摊出来（况且关掉菜单时它又会自己收回去，像在抽动）。
	 */
	const isOpenAt = (project: PiProject, index: number) => isProjectOpen(project, index, openMap, activeId);
	const allOpen = groups.every((project, index) => isOpenAt(project, index));
	/* 置顶的会话：跨项目汇总成一组，作为「项目」里的**第一个子组**（跟项目平级排在列表最前）。
	 * 顺序按 `sessionPrefs.pinned` 数组顺序（新置顶的排前面）；归档的不进这一组。
	 * 行尾**不带项目名**（用户要求去掉：标题已经够认人，项目名挤在右边还占宽度），
	 * 跟项目分组里的会话一样显示相对时间。
	 */
	const pinnedEntries = groups
		.flatMap((project) =>
			project.sessions.filter(
				(session) => sessionPrefs.pinned.includes(session.id) && !sessionPrefs.archived.includes(session.id),
			),
		)
		.sort((a, b) => sessionPrefs.pinned.indexOf(a.id) - sessionPrefs.pinned.indexOf(b.id));
	/**
	 * 每个项目这一帧要画哪几条会话（归档/置顶过滤、排序、折叠、条数上限全在这里算一次）。
	 * **渲染与 Shift 连选共用同一份**：各算一遍的话，连选的范围迟早会和眼睛看到的顺序对不上。
	 */
	const rowsOf = new Map<
		string,
		{ expanded: boolean; visibleSessions: PiSessionSummary[]; shown: PiSessionSummary[] }
	>();
	for (const project of groups) {
		const visibleSessions = rankSessions(
			// 归档的隐藏；全局置顶的挪到最上面的「置顶」组里，这里不再重复出现
			project.sessions.filter(
				(session) => !sessionPrefs.archived.includes(session.id) && !sessionPrefs.pinned.includes(session.id),
			),
			sessionPrefs.order,
		);
		const expanded = showAll[project.cwd] === true;
		rowsOf.set(project.cwd, {
			expanded,
			visibleSessions,
			shown: expanded ? visibleSessions : visibleSessions.slice(0, sessionsPerProject),
		});
	}
	/**
	 * 当前**看得见**的会话顺序（从上到下）：置顶组 → 各展开项目里画出来的那几条。
	 * Shift 连选就是在这条序列上切一段 —— 折叠起来的项目不算（看不见的不该被顺手选中），
	 * 没展开的「还有 N 个…」也不算。
	 */
	const visibleSessionIds: string[] = [];
	if (!archivedView) {
		if (pinnedEntries.length > 0 && pinnedOpen) visibleSessionIds.push(...pinnedEntries.map((session) => session.id));
		if (projectsOpen)
			groups.forEach((project, index) => {
				const plan = rowsOf.get(project.cwd);
				if (!plan || !isOpenAt(project, index)) return;
				visibleSessionIds.push(...plan.shown.map((session) => session.id));
			});
	}
	/** 清空多选（批量菜单里的「取消选择」、切归档视图、选完干完活都走这里） */
	const clearSelection = () => {
		setSelectedIds([]);
		setBatchMenu(null);
		selectAnchor.current = null;
	};
	/** Shift 连选：从锚点切到这一条（含两端）；没有锚点（比如一上来就 Shift）就退化成只选这一条 */
	const selectRange = (id: string) => {
		const next = rangeSelection(visibleSessionIds, selectAnchor.current, id);
		setSelectedIds(next);
		// 没有锚点（或锚点已经看不见了）时，把这一条当新锚点，下一次 Shift 才有起点
		if (next.length === 1) selectAnchor.current = id;
	};
	/** Ctrl/⌘ 加减选（锚点跟到最后点的那条，之后的 Shift 才有起点） */
	const toggleSelected = (id: string) => {
		setSelectedIds((current) => toggleSelection(current, id));
		selectAnchor.current = id;
	};
	/**
	 * 批量归档：**一次写完整张 `archived`**。
	 *
	 * 会话偏好是整表覆盖写的：逐条发的话，第二条起都会基于旧快照算，服务端一覆盖就只剩最后一条生效
	 * （归档视图里批量还原那条注释也记的是同一个坑）。提示里给「撤销」与「查看」。
	 */
	const archiveSelected = () => {
		const ids = selectedIds;
		if (ids.length === 0) return;
		const drop = new Set(ids);
		const latest = latestSessionPrefs();
		patchSessionPrefs({ archived: [...latest.archived.filter((id) => !drop.has(id)), ...ids] });
		clearSelection();
		showToast({
			text: t(`已归档 ${ids.length} 条会话`, `Archived ${ids.length} session(s)`),
			actions: [
				{
					label: t("撤销", "Undo"),
					onClick: () => {
						// 撤销也读最新一份：这中间可能又归档过别的
						patchSessionPrefs({ archived: latestSessionPrefs().archived.filter((id) => !drop.has(id)) });
					},
				},
				{ label: t("查看", "View"), onClick: () => setArchivedView(true) },
			],
		});
	};
	/** 批量删除（确认已在菜单里做过一道：第一下上膛、第二下真删） */
	const deleteSelected = () => {
		const ids = selectedIds;
		if (ids.length === 0) return;
		clearSelection();
		deleteSessions(ids, t(`选中的 ${ids.length} 条会话`, `${ids.length} selected session(s)`));
	};
	/**
	 * 选中的会话要是已经不在可见列表里了（被删 / 被归档 / 换到归档视图 / 项目被折叠），静默剔掉。
	 * 不剔的话批量菜单会写着「已选 5 条」，实际只剩两条还在列表里 —— 那时候点「删除」就少删仨，谁都看不出来。
	 */
	useEffect(() => {
		if (selectedIds.length === 0) return;
		const next = pruneSelection(selectedIds, visibleSessionIds);
		if (next.length !== selectedIds.length) setSelectedIds(next);
	});
	/* 点标题右边那枚「全部收起/展开」：一次把下面所有项目设成同一个开合状态。
	 * 「置顶」子组跟着一起走 —— 它现在在「项目」里面，
	 * 否则点了「全部收起」它自己还摊着，看着像没收干净。 */
	const toggleAllProjects = () => {
		setOpenMap(Object.fromEntries(groups.map((group) => [group.cwd, !allOpen])));
		setPinnedOpen(!allOpen);
	};

	/**
	 * 渲染一条会话（「置顶」分组与项目分组共用）。
	 * 同一个会话不会出现两次 —— 项目分组里已经把置顶的过滤掉了。
	 */

	/** 拖起一条会话：记下源（dataTransfer 只带 id，供浏览器拖拽生效） */
	const startDrag = (session: PiSessionSummary) => {
		setDrag({ id: session.id, cwd: session.cwd });
	};
	/** 拖完（成功 / 取消都走这里）清掉所有高亮 */
	const endDrag = () => {
		setDrag(null);
		setDragOverCwd(null);
		setDragOverSession(null);
	};
	/** 拖到项目上 = 搬家到那个项目（同项目则不动） */ /**
	 * 置顶组内互换位置：把拖着的会话插到目标会话前面，落盘成 `sessionPrefs.pinned`。
	 *
	 * 只在「拖的也是置顶的」时才接（`pinnedSortTarget`）：否则那是「拖进来顺便 📌」的语义，
	 * 一次手势干两件事（置顶 + 跨项目搬家）容易连自己都说不清，置顶仍走行上的 📌 / 右键菜单。
	 *
	 * 排序基准用 `pinned` 数组本身，**不是**渲染出来的 `pinnedEntries`：后者只包含当前已加载
	 * 工作区里的会话，拿它回写会把别的项目里置顶着的 id 静默丢掉。
	 */
	const dropOnPinnedSession = (targetId: string) => {
		if (!drag || drag.id === targetId) return;
		const list = [...latestSessionPrefs().pinned];
		const from = list.indexOf(drag.id);
		const to = list.indexOf(targetId);
		if (from < 0 || to < 0) return;
		list.splice(from, 1);
		list.splice(to, 0, drag.id);
		patchSessionPrefs({ pinned: list });
	};
	/** 置顶组里的行能不能当落点：拖的也得是置顶的那几条，否则不亮插入位（见 `dropOnPinnedSession`） */
	const pinnedSortTarget = !!drag && sessionPrefs.pinned.includes(drag.id);
	/**
	 * 拖到项目上：
	 *   - 别的项目的 → **搬家**（`move_session`），落到这个项目的**第一条**（用户 2026-10-29：
	 *     「移动会话时，可以将会话移动到其它项目中去，默认放在项目的最前面」）；
	 *   - 同一个项目的 → 不搬家，只把它提到这个项目最前面（拖到项目名上就是这个意思）。
	 *
	 * 两种都写 `sessionPrefs.order`：`withSessionFirst` 一提，它就是本项目的第一名。
	 */
	const dropOnProject = (project: PiProject) => {
		if (!drag) return;
		if (drag.cwd !== project.cwd) moveSession(drag.id, project.cwd);
		const latest = latestSessionPrefs();
		// 整表覆盖写：拿刚读到的 latest 铺底（闭包里那份可能是上几帧的，会盖掉别人刚写的改动）
		setSettings({ sessionPrefs: { ...latest, order: withSessionFirst(latest.order, drag.id) } });
	};
	/**
	 * 同项目内拖到某条会话上 = 排序：把拖着的**插到它前面**（`sessionPrefs.order` 落盘）。
	 *
	 * 落盘的是「这个项目的新完整顺序」：先从当前渲染顺序算出来（手动位置 + 创建时间兜底），
	 * 再用 `withProjectOrder` 整体挪到 `order` 的前面 —— 别的项目的先后不受影响。
	 */
	const dropOnProjectSession = (project: PiProject, targetId: string) => {
		if (!drag || drag.id === targetId) return;
		if (drag.cwd !== project.cwd) return; // 跨项目交给 project 的 drop（那才是搬家）
		const latest = latestSessionPrefs();
		const current = rankSessions(project.sessions, latest.order).map((session) => session.id);
		const next = insertBefore(current, drag.id, targetId);
		if (next === current) return;
		setSettings({ sessionPrefs: { ...latest, order: withProjectOrder(latest.order, current, next) } });
	};
	const renderSession = (session: PiSessionSummary, options: { project?: PiProject; pinnedGroup?: boolean } = {}) => (
		<SessionRow
			key={session.id}
			session={session}
			active={session.id === activeId}
			selected={selectedIds.includes(session.id)}
			running={runningIds.includes(session.id)}
			unseen={unseen[session.id] !== undefined}
			title={titleOf(session) || "（无标题）"}
			pinned={sessionPrefs.pinned.includes(session.id)}
			menuPoint={sessionMenu?.id === session.id ? sessionMenu.point : null}
			onOpenMenu={(point) => {
				// 右键落在「已经选中且不止一条」上 = 想动这一批 → 批量菜单（见 SessionBatchMenu）
				if (selectedIds.length > 1 && selectedIds.includes(session.id)) {
					setSessionMenu(null);
					setBatchMenu({ point });
					return;
				}
				// 否则按「右键了这一条」处理：先把选区收成这一条（跟 Finder / VS Code 一致），再弹单条菜单
				setBatchMenu(null);
				setSelectedIds([session.id]);
				selectAnchor.current = session.id;
				setSessionMenu({ id: session.id, point });
			}}
			onSwitch={({ shift, toggle }) => {
				// Shift：从锚点连选一段（**不**切会话 —— 只是选，往往下一步就是右键批量操作）
				if (shift) {
					selectRange(session.id);
					return;
				}
				// Ctrl/⌘：这条加减选，也不切会话
				if (toggle) {
					toggleSelected(session.id);
					return;
				}
				// 普通点击：清空多选 + 设为新锚点 + 打开会话（原来那一套行为不变）
				setSelectedIds([]);
				setBatchMenu(null);
				selectAnchor.current = session.id;
				// 点开 = 看过了：先抹圆点（不等下一帧快照，点了就消失），再切会话
				clearUnseen(session.id);
				switchConversation(session.id);
			}}
			onPin={() => {
				// 用最新那份算：连着点两下、或别的客户端刚改过时，闭包里那份会把对方的结果盖掉
				const pinned = latestSessionPrefs().pinned;
				patchSessionPrefs({
					pinned: pinned.includes(session.id) ? pinned.filter((id) => id !== session.id) : [...pinned, session.id],
				});
			}}
			onRename={(next) => {
				// 就地编辑提交：名字写进 pi 的会话文件（session_info），不弹窗
				renameSession(session.id, next);
			}}
			onArchive={() => archiveSession(session.id, titleOf(session))}
			onOpenInNewTab={() => window.open(sessionUrlFor(window.location.href, session.id), "_blank", "noopener")}
			onDelete={() => deleteSession(session.id, titleOf(session) || session.id)}
			onCloseMenu={() => setSessionMenu(null)}
			draggable
			onDragStart={() => startDrag(session)}
			onDragEnd={endDrag}
			/* 行内互换位置的落点，两套：
			   - **置顶组**：顺序存在 `sessionPrefs.pinned`（拖的也必须已经是置顶的，见 `pinnedSortTarget`）；
			   - **项目分组**：顺序存在 `sessionPrefs.order`（2026-10-29 用户要的拖动排序）——
			     只接「同一个项目内」的拖拽；拖到**别的项目**的行上不接，让 drop 冒泡到 <details>，
			     那才是「搬家到那个项目」的语义。
			   拖项目（`projDrag`）时一律不当目标：那是改项目顺序，跟会话顺序无关。 */
			{...(() => {
				if (projDrag) return {};
				const asTarget = {
					dragOver: dragOverSession === session.id,
					onDragOver: () => setDragOverSession(session.id),
					onDragLeave: () => setDragOverSession((current) => (current === session.id ? null : current)),
				};
				if (options.pinnedGroup) {
					return pinnedSortTarget ? { ...asTarget, onDrop: () => dropOnPinnedSession(session.id) } : {};
				}
				const project = options.project;
				if (!project || !drag || drag.cwd !== project.cwd || drag.id === session.id) return {};
				return { ...asTarget, onDrop: () => dropOnProjectSession(project, session.id) };
			})()}
		/>
	);

	return (
		<aside className="sidebar">
			{/*
			 * 「置顶」排在整个「项目」这一块的**上面**，独立成一段（2026-10-29 用户两次确认：
			 * 「置顶不能在里面」）。它仍是**跨项目汇总**的一组会话，跟某个项目不是一类。
			 *
			 * 位置来回挪过两次，记在这儿免得又绕回去：
			 *   1. 原来在「项目」列表里当第一个子组；
			 *   2. 2026-10-29 早上提到抬头上面；
			 *   3. 同日被我改回列表里（用户要求「放回项目里」）—— **原样撤回**，
			 *      因为用户随后明确「置顶不能在里面」。
			 *
			 * 在抬头上面就要自己管两件事（都在 sidebar.css 的 `.pin-group` 里）：
			 *  - 不跟项目列表一起滚（置顶的几条永远在最上面）；
			 *  - 会话多了自己滚（`max-height: 34vh`），别把下面的列表顶没。
			 */}
			{/*
			 * 只在「归档视图」里收起：那个视图整块讲的是另一件事（归档的会话），
			 * 置顶组留在上面会让人以为归档里也有它们。
			 * **不跟「项目」那个折叠开关走**：它在「项目」这一块**上面**，是独立一段。
			 */}
			{pinnedEntries.length > 0 && !archivedView ? (
				<section className="pin-group">
					<button
						type="button"
						className="pin-group-head sidebar-title"
						title={pinnedOpen ? "收起置顶" : "展开置顶"}
						aria-expanded={pinnedOpen}
						onClick={() => setPinnedOpen((open) => !open)}
					>
						{/* 跟下面「项目」「文件」两个标题**完全同一套**（用户 2026-10-29：\u201c风格统一一些\u201d）：
						 * 三角 + 文字、14.5px / 600 / hover 变强调色、`aria-expanded` 转三角。
						 * 颜色用 `--text`（黑）而不是隔壁那两行的 `--text-dim`：用户 2026-10-29 晚
						 * “置顶会话 改回黑色”（金色那版撤了）。文案也收成两个字“置顶” —— 与下面
						 * 项目行上那枚 “置顶项目” 📌 不冲突：这一组下面摆的就是会话行，不会认错。 */}
						<span
							className={`sidebar-title-caret${pinnedOpen ? " sidebar-title-caret-open" : ""}`}
							aria-hidden="true"
						/>
						<span className="sidebar-title-label">置顶</span>
					</button>
					{pinnedOpen ? (
						<div className="pin-group-body">
							{/* 置顶组：不画「归档」按钮 —— 这一组本来就是「随手要点的几条」，
									    右键 / 「⋯」里的菜单一样能归档。时间行尾已全列表不画了。 */}
							{pinnedEntries.map((session) => renderSession(session, { pinnedGroup: true }))}
						</div>
					) : null}
				</section>
			) : null}
			<div className={`sidebar-head${selectedIds.length > 0 ? " sidebar-head-selecting" : ""}`}>
				{/* 标题 = 整块的开关（跟下面「文件管理」一致）：点一下把这条列表整体收起，再点展开 */}
				<button
					type="button"
					className="sidebar-title"
					title={projectsOpen ? t("收起项目管理", "Collapse projects") : t("展开项目管理", "Expand projects")}
					aria-expanded={projectsOpen}
					onClick={() => setProjectsOpen((open) => !open)}
				>
					{/* 三角放在**文字左边**（用户要求：跟「文件」那一行一致，也都更像「这一行能展开」）：
					 * 三角 `flex: none` 不被挤掉，文字侧栏拉窄时走省略号。 */}
					<span
						className={`sidebar-title-caret${projectsOpen ? " sidebar-title-caret-open" : ""}`}
						aria-hidden="true"
					/>
					<span className="sidebar-title-label">
						{/* 标题写「项目管理」（用户 2026-10-29）：跟下面「文件管理」对齐，一眼看出这是「管项目的」那一栏。
						 * 名字后面原来跟一个「（12）」的项目数 —— 不能点也没人数，纯噪声，早就去掉了。 */}
						{t("项目管理", "Projects")}
					</span>
				</button>
				{/*
				 * 多选时：标题旁边直接挂「已选 N 条 · 归档 · 删除」（用户 2026-10-29：「不用右键也能操作」）。
				 *
				 * 为什么占掉「＋ 新建项目 / ⇕ 全部收起」的位置：这一行只有侧栏那么宽，再塞三块进去
				 * 就只能把「项目管理」挤成省略号。选着一批会话时用户正在干的事只有一件（归档/删除），
				 * 那两颗图标属于「平时逛列表」的场景，取消选择（✕）之后就回来。
				 * 删除仍须两下：第一下上膛、第二下真删（`useArmed`，5 秒不管就自己缩回）。
				 */}
				{selectedIds.length > 0 ? (
					<SessionSelectionBar
						count={selectedIds.length}
						onArchive={archiveSelected}
						onDelete={deleteSelected}
						onClear={clearSelection}
					/>
				) : null}
				{/*
				 * 「＋ 新建项目」：**紧跟在「项目」后面、在「⇕ 全部收起」之前**（用户要求挪到这里）。
				 * 以前它被 `margin-left: auto` 顶到这一行最右边，跟左边那几颗（项目 / ⇕ / 新会话）
				 * 隔着一整条空白，看着像两个不相干的组；挪进来之后这一行就是一件事：
				 * 「项目」这一栏能怎么动 —— 新建、全部收展、开一条新会话。
				 * 几何跟旁边那颗「⇕」完全一致（22×20 / 圆角 6 / 同粗描边），不会一粗一细。
				 */}
				<button
					type="button"
					className={`sidebar-icon sidebar-icon-inline${selectedIds.length > 0 ? " sidebar-icon-away" : ""}`}
					title={t("新建项目（选择一个本地目录）", "New project (pick a local folder)")}
					aria-label={t("新建项目", "New project")}
					onClick={onNewProject}
				>
					{/* 「文件夹 + 加号」= 新建项目：比一个光秃秃的加号更能说明「建的是个项目」 */}
					<FolderPlusIcon />
				</button>
				{/* 「全部收起/展开」紧贴标题文字（原在最右边那组图标里）：
				 * 它管的就是这条列表里的项目，跟在「项目」后面才看得出是同一件事。
				 * **一直显示**（整块收起时也留着）—— 之前整块一收起这枚就消失，
				 * 位置一变人还以为点错了。整块收着时点它 = 先展开列表、再把各项目都摊开。 */}
				<button
					type="button"
					className={`sidebar-icon sidebar-icon-inline${selectedIds.length > 0 ? " sidebar-icon-away" : ""}`}
					title={
						allOpen
							? t("全部收起（只留项目名）", "Collapse all (project names only)")
							: t("全部展开（显示各项目的会话）", "Expand all (show each project's sessions)")
					}
					aria-label={allOpen ? t("全部收起", "Collapse all") : t("全部展开", "Expand all")}
					aria-pressed={allOpen}
					onClick={() => {
						if (!projectsOpen) {
							setProjectsOpen(true);
							setOpenMap(Object.fromEntries(groups.map((group) => [group.cwd, true])));
							setPinnedOpen(true);
							return;
						}
						toggleAllProjects();
					}}
				>
					{/* 两个尖角对着中间那道线 = 「把下面的都收起来」（VS Code 折叠全部同一语义） */}
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M5.4 2.4 8 5.2 10.6 2.4" />
						<path d="M5.4 13.6 8 10.8 10.6 13.6" />
						<path d="M2.8 8h10.4" />
					</svg>
				</button>
				{/*
				 * 「新会话」：**平时不在这一行** —— 它在顶栏（App.tsx），侧栏展开 / 收起都是那一颗。
				 * 用户定的优先级：先放顶部；顶部不显示（顶栏被状态栏那颗 ▴/▾ 藏起来）时才放回这里，
				 * 也就是现在这个位置（紧跟「项目 ⇕」、在「＋ 新建项目」之前）。
				 * 两处是同一个动作、任一时刻只有一颗：这里加了条件，顶栏那条就不用再靠 CSS 收。
				 */}
				{appbarHidden ? <NewChatButton variant="sidebar" /> : null}
				{/*
				 * 标题右边那一大片空白也是开关（用户 2026-10-29：「点旁边的空白处，它就可以展开或收起」）。
				 * 这里是一颗**只当鼠标热区**的透明按钮，把这一行剩下的宽度占满就行。
				 * 为什么不用「把标题那颗拉宽」（`flex: 1`）：那样后面的 ＋ / ⇕ / 新会话会被顶到最右边，
				 * 而用户明确要求过「动作紧跟标题」（见上面那段注释），布局不能为了热区倒退回去。
				 * 键盘 / 读屏仍走标题那颗：这颗 `tabIndex={-1}` + `aria-hidden`，不进 Tab 序列。
				 */}
				<button
					type="button"
					className="sidebar-row-fill"
					aria-hidden="true"
					tabIndex={-1}
					onClick={() => setProjectsOpen((open) => !open)}
				/>
			</div>

			<div
				className={`sidebar-list${archivedView ? " sidebar-list-hidden" : ""}${projectsOpen ? "" : " sidebar-list-hidden"}`}
				/*
				 * 拖项目换顺序的**投放区就是这条列表**（不是只有几像素高的表头）：
				 * 以前只在 `.proj-head` 上接 dragover/drop，落在会话列表区、行间空隙、
				 * 列表底部全都没反应 —— 松手就回原位，用户看到的就是「拖了跟没拖一样」。
				 *
				 * 落点按「指针在各项目**表头中线**的上/下」算：第一个中线在指针下面的项目就是目标，
				 * 指针在它上半 → 插到它前面；都没命中（落在最底部）→ 插到最后一个后面。
				 * 这样整块区域都是有效落点，手不用去找那 20px 高的一条横线。
				 */
				onDragOver={(event) => {
					if (!projDrag) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					const drop = projectDropAt(event.currentTarget, event.clientY);
					if (drop) setProjDrop(drop);
				}}
				onDragLeave={(event) => {
					// 只在真离开这条列表时清掉落点（在行与行之间移动会连续触发 leave）
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProjDrop(null);
				}}
				onDrop={(event) => {
					if (!projDrag) return;
					event.preventDefault();
					event.stopPropagation();
					const drop = projectDropAt(event.currentTarget, event.clientY);
					if (drop) moveProjectTo(projDrag, drop.cwd, drop.after);
					setProjDrag(null);
					setProjDrop(null);
				}}
			>
				{groups.length === 0 ? (
					<div className="sidebar-empty">
						{t(
							"还没有会话。发一条消息就会自动建一个；「临时会话（不保存）」不会留在这里。",
							"No sessions yet. Sending a message creates one — but a “temporary session (not saved)” never shows up here.",
						)}
					</div>
				) : null}
				{groups.map((project, index) => {
					const plan = rowsOf.get(project.cwd)!;
					const { expanded, visibleSessions, shown } = plan;
					const rest = visibleSessions.length - shown.length;
					const name = aliases[project.cwd] || project.name || t("未分组", "Ungrouped");
					const projectOpen = isOpenAt(project, index);
					/**
					 * 项目**折叠**时，组内的会话行根本看不见 —— 运行状态得顶到项目行上来，
					 * 否则你以为这项目闲着。展开的时候每行自己会显示，项目行不用再重复一遍。
					 * 项目行上只画那颗转圈，不带「运行中」三个字（见下面那段）。
					 */
					const projectRunning = project.sessions.some((session) => runningIds.includes(session.id));
					// 同上：「跑完了、你还没看」的会话也要能从这个折叠着的项目行上看出来
					const projectUnseen = project.sessions.filter(
						(session) => unseen[session.id] !== undefined && !sessionPrefs.archived.includes(session.id),
					);
					void knownWorkspaces;
					return (
						<details
							data-cwd={project.cwd}
							className={`proj${dragOverCwd === project.cwd ? " proj-drag-over" : ""}${
								projDrag === project.cwd ? " proj-dragging" : ""
							}${projDrop?.cwd === project.cwd ? (projDrop.after ? " proj-drop-after" : " proj-drop-before") : ""}`}
							key={project.cwd || name}
							open={projectOpen}
							onMouseDown={(event) => {
								// 右键 / 中键：记一笔，等会儿 onToggle 要据此把它压掉
								if (event.button !== 0) nonPrimaryPressAt.current = performance.now();
							}}
							onToggle={(event) => {
								const details = event.currentTarget as HTMLDetailsElement;
								const next = details.open;
								if (longPressOpened.current) {
									/* 长按刚开过菜单：松手带出来的这次「展开 / 收起」不是用户要的。
									 * 为什么只能在这里回滚、不能靠 `click` 里 `preventDefault`：
									 * Chrome 的 `<details>` 是在 **mouseup** 那一刻就切了（上面
									 * `nonPrimaryPressAt` 那段注释里也记着同一件事）——等 click 来时木已成舟。
									 * 另外 `toggle` 事件是**异步**派发的：它比松手补的那次 click 还晚，
									 * 所以「标记」必须在这里（onToggle）消费，不能在 onClick 里清掉。 */
									longPressOpened.current = false;
									details.open = projectOpen;
									return;
								}
								if (performance.now() - nonPrimaryPressAt.current < 400) {
									// 右键 / 中键带出来的折叠：DOM 改回去，也不写进状态（用户只想开菜单）
									details.open = projectOpen;
									return;
								}
								setOpenMap((current) => ({ ...current, [project.cwd]: next }));
							}}
							onDragOver={(event) => {
								// 拖的是项目 = 改顺序，走下面 summary 那套（这里不接）
								if (projDrag || !drag) return;
								/**
								 * 两类都接受放下：
								 *   - **别的项目**拖进来 → 搬家（落点项目第一条）；
								 *   - **同一个项目**拖到项目名 / 行间空隙 → 挪到本项目第一条
								 *     （2026-10-29 的拖动排序；行与行之间的细排由会话行自己接，它 stopPropagation）。
								 *
								 * 但**虚线框只给「跨项目」**：同项目排序时指针必然扫过整个项目区，
								 * 框一亮一灭地闪反而像出错了。
								 */
								event.preventDefault();
								if (drag.cwd !== project.cwd) setDragOverCwd(project.cwd);
							}}
							onDragLeave={() => setDragOverCwd((current) => (current === project.cwd ? null : current))}
							onDrop={(event) => {
								if (projDrag) return;
								event.preventDefault();
								if (drag) dropOnProject(project);
								endDrag();
							}}
						>
							<summary
								className="proj-head"
								title={`${project.cwd || t("未分组", "Ungrouped")}\n拖动可换项目顺序　右键：项目菜单`}
								/* 拖这一行 = 改项目顺序（会话拖动那套在行里，两套互不干扰）。
								   改名时关掉：不然在输入框里选字会变成「拖着整行跑」。 */
								draggable={renaming?.cwd !== project.cwd}
								onDragStart={(event) => {
									// 自带的「拖文本」也要压掉，否则会同时触发浏览器默认的选区拖拽
									event.dataTransfer.setData("text/plain", project.cwd);
									event.dataTransfer.effectAllowed = "move";
									setProjDrag(project.cwd);
								}}
								onDragEnd={() => {
									setProjDrag(null);
									setProjDrop(null);
								}}
								onContextMenu={(event) => {
									// 右键 = 项目菜单（行尾那颗「⋯」在手机上已经收掉了）
									event.preventDefault();
									event.stopPropagation();
									cancelLongPress();
									setProjectMenu({
										cwd: project.cwd,
										point: { x: event.clientX, y: event.clientY },
										anchor: event.currentTarget,
									});
								}}
								/* 长按 = 同一张菜单（触摸屏没有右键，也没有那颗「⋯」了，见上面 longPress 的注释） */
								onPointerDown={(event) => {
									longPressOpened.current = false;
									cancelLongPress();
									// 只认手指：鼠标按住不动不该弹菜单（那是拖拽的起点）
									if (event.pointerType !== "touch") return;
									// 改名中：这一行是输入框，长按要留给选字
									if (renaming?.cwd === project.cwd) return;
									const anchor = event.currentTarget as HTMLElement;
									const point = { x: event.clientX, y: event.clientY };
									const timer = window.setTimeout(() => {
										longPress.current = null;
										longPressOpened.current = true;
										setProjectMenu({ cwd: project.cwd, point, anchor });
									}, 450);
									longPress.current = { timer, x: point.x, y: point.y };
								}}
								onPointerMove={(event) => {
									// 手指一动（滑动列表 / 拖项目）就不算长按
									const press = longPress.current;
									if (!press) return;
									if (Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10) {
										cancelLongPress();
									}
								}}
								onPointerUp={cancelLongPress}
								onPointerCancel={cancelLongPress}
								onPointerLeave={cancelLongPress}
								onClick={(event) => {
									// 长按刚开过菜单：这一次 click 是松手补上的，什么都不做
									// （折叠那件事已经在 onToggle 里回滚掉了 —— 这里再 preventDefault 也拦不住）
									if (longPressOpened.current) {
										// 只跳过这次 click 的副作用，**标记留到 onToggle 里消费**：
										// `toggle` 事件是异步派发的（比 click 还晚一个任务），在这里清掉的话
										// 回滚分支永远等不到它 —— 项目就被顺手折叠了（实测过）。
										return;
									}
									// 正在改名时点这一行不要展开/收起（否则输入框会被卸载）
									if (renaming?.cwd === project.cwd) event.preventDefault();
									// 点一下项目行 = 我看到了它底下的东西：项目行上的圆点就抹掉
									// （「一旦点击后圆点就消失」——圆点自己不是按钮，点击落在这一行上）
									clearUnseenMany(project.sessions.map((session) => session.id));
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
								{/*
								 * 折叠时把「在跑」顶到项目行上，而且**只留那颗转圈**（用户 2026-10-29：「运行中」几个字去掉）：
								 * 项目名本来就长，再跟三个字进去会把名字挤没；转圈 + 悬浮提示已经够说清楚。
								 */}
								{!projectOpen && projectRunning ? (
									<span
										className="proj-busy"
										role="img"
										aria-label={t("这个项目里有会话正在跑", "A session in this project is running")}
										title={t(
											"这个项目里有会话正在跑（展开就能看到是哪一条）",
											"A session in this project is running (expand to see which)",
										)}
									>
										<span className="proj-busy-ring" aria-hidden="true" />
									</span>
								) : !projectOpen && projectUnseen.length > 0 ? (
									<span
										className="proj-unseen"
										role="img"
										aria-label={t("有会话跑完了、你还没看", "A session finished and is not reviewed yet")}
										title={t(
											`有 ${projectUnseen.length} 条会话跑完了、你还没看（点一下这个项目就消失）`,
											`${projectUnseen.length} session(s) finished and unreviewed (click the project to clear)`,
										)}
									/>
								) : null}
								{pinned.includes(project.cwd) ? (
									<span className="proj-pin" title={t("已置顶")} aria-label={t("已置顶")}>
										📌
									</span>
								) : null}
								<button
									type="button"
									className="proj-more"
									title={t("项目菜单（新建会话 / 重命名 / 定位…）")}
									onClick={(event) => {
										event.preventDefault(); // 别把 details 一起展开/收起
										event.stopPropagation();
										// 和右键同一张菜单：从这一行的右下角弹出来
										const rect = event.currentTarget.getBoundingClientRect();
										setProjectMenu({
											cwd: project.cwd,
											point: { x: rect.left, y: rect.bottom + 2 },
											anchor: event.currentTarget.closest(".proj-head") as HTMLElement | null,
										});
									}}
								>
									⋯
								</button>
							</summary>
							{projectMenu?.cwd === project.cwd ? (
								<ProjectMenu
									anchor={projectMenu.anchor}
									onClose={() => setProjectMenu(null)}
									pinned={pinned.includes(project.cwd)}
									onTogglePin={() => togglePin(project.cwd)}
									/* 不在这里建会话：切到「新会话」那一屏并预选这个项目，发第一条消息时才建（见 store 的 newSession） */
									onNewSession={() => startNewSession(project.cwd)}
									onMoveUp={() => moveWithin(project.cwd, -1)}
									onMoveDown={() => moveWithin(project.cwd, 1)}
									onRename={() => setRenaming({ cwd: project.cwd, draft: name })}
									onOpenFiles={() => {
										// 定位 = 文件区打开 + 根切到这个项目（还能在下面的下拉框里再换）
										onRootChange(project.cwd);
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
								{shown.map((session) => renderSession(session, { project }))}
								{rest > 0 ? (
									<button
										type="button"
										className="pi-row pi-row-more"
										title={expanded ? "收起，只显示前几个" : `展开，显示全部 ${visibleSessions.length} 个会话`}
										onClick={() => setShowAll((current) => ({ ...current, [project.cwd]: !expanded }))}
									>
										{expanded ? t("收起", "Collapse") : t(`还有 ${rest} 个…`, `and ${rest} more…`)}
									</button>
								) : expanded && visibleSessions.length > sessionsPerProject ? (
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
				{/* 「已归档」单独一行，跟项目文件夹同一层（列表最后一行）—— 不再挂在标题栏上 */}
				<ArchivedEntryRow total={archivedTotal} active={archivedView} onOpen={() => setArchivedView(true)} />
			</div>
			<ArchivedSection
				groups={archivedGroups}
				view={archivedView}
				onBack={() => setArchivedView(false)}
				onOpen={(id) => {
					clearSelection();
					void switchConversation(id);
					setArchivedView(false);
				}}
				onRestore={restoreSession}
				onRestoreMany={(ids) => {
					// 一次算完再发：批量恢复不能逐条发（每条都基于旧列表，服务端整表覆盖 → 只剩一条生效）
					const drop = new Set(ids);
					patchSessionPrefs({ archived: latestSessionPrefs().archived.filter((item) => !drop.has(item)) });
				}}
			/>
			{/* 多选后的右键菜单：批量归档 / 批量删除（只对“这一批会话都成立”的动作，见组件注释） */}
			{batchMenu ? (
				<SessionBatchMenu
					point={batchMenu.point}
					count={selectedIds.length}
					onArchive={archiveSelected}
					onDelete={deleteSelected}
					onClear={clearSelection}
					onClose={() => setBatchMenu(null)}
				/>
			) : null}
			{/* 项目列表收起时文件区直接撑到底：这时没有「上下两块」可拖，隐藏分割条 */}
			{archivedView || !projectsOpen ? null : (
				<SideSplitter open={fileOpen} onOpen={() => setFileOpen(true)} onStart={split.start} onReset={split.reset} />
			)}
			{archivedView ? null : (
				<SidebarFiles
					open={fileOpen}
					onToggle={() => setFileOpen((open) => !open)}
					height={split.height}
					/* 项目整块收起 → 文件区顶到底（原来它还是固定高度，下面空一大块） */
					fill={!projectsOpen}
					root={root ?? currentRoot ?? null}
					onRootChange={onRootChange}
					options={groups.map((project) => ({
						cwd: project.cwd,
						label: aliases[project.cwd] || project.name || project.cwd,
					}))}
					onOpenFile={(path) => onOpenFile?.(path, root ?? currentRoot ?? "")}
					activePath={activePath ?? null}
					revealSeq={revealSeq ?? 0}
					revealPath={revealPath ?? null}
					onRevealPath={onRevealPath}
					onOpenTerminal={() => {
						const target = root ?? currentRoot;
						if (target) onOpenTerminal?.(target);
					}}
					// 在 Finder 中显示：复用项目菜单那条后端接口（只定位，不执行文件）
					onSearchContents={onSearchContents}
					onReveal={(cwd) =>
						void fetch("/api/projects/reveal", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ cwd }),
						})
					}
				/>
			)}
			{/*
			 * 侧栏底部那里**不再画「收起」**（用户：「这里这个不要呀」）。
			 * 「收起 / 展开」现在只有一处：分割线上那颗舌形箭头（`.side-collapse` / `.side-expand`，
			 * 见 App.tsx）—— 它骑在分栏线上、就在侧栏右上角，本来就是最顺手的那一处；
			 * 再来一颗小方块，同一件事两个样子、位置还差一整个栏高，反而让人犹豫点哪颗。
			 */}
		</aside>
	);
}
