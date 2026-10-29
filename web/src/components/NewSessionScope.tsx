import { useEffect, useRef, useState } from "react";
import { basename, normalizeCwd } from "../path-utils.ts";
import type { ProjectPrefs } from "../types.ts";
import { sortProjects } from "../project-sort.ts";
import { useAppState } from "../store.ts";
import { useGitBranch } from "../use-git-branch.ts";
import { BranchIcon } from "./BranchIcon.tsx";
import { FolderIcon, FolderPlusIcon } from "./FolderIcon.tsx";
import { GitBranchMenu } from "./GitBranchMenu.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { ProjectMenuPopover } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";

/**
 * 「新会话」刚点下、还没真建的时候，工具行里多出来的两颗：**项目 · 分支**。
 *
 * 位置（用户要求）：排在**模型那颗的左边**，跟「模型 / 模板 / 想想」同一排、同一套胶囊样式 ——
 * 不再单占输入框上方一整行（那样太占地方，也跟这一排按钮看着不像一家人）。
 *
 * 为什么要有：会话属于哪个项目，以前是「点哪儿的 + 就落哪儿」，抬头那颗「新会话」只能
 * 继承上一条会话的目录 —— 想换项目得先去侧栏找对应项目的「+」。这两颗把「这条会话落在
 * 哪个项目」变成新会话的第一件可选的事：左边选项目，右边看/切该项目的 git 分支。
 * 不是 git 仓库时分支那颗整颗不画，界上只剩项目一颗（用户明确要求「没有 git 的话只要一个」）。
 *
 * 两条规矩（都来自需求本身）：
 *  1. 项目下拉框里的项目 = **左边侧栏已有的那些项目**（同一份 `snapshot.piProjects`，
 *     连排序/别名都跟侧栏一致：置顶在前、自定义顺序、别名优先），不另造一份清单；
 *  2. 分支只对**git 仓库**显示；不是仓库、或者拿不到分支时整颗不画（不留一个空壳）；
 *     点它弹的是文件区那枚分支标签**同一张菜单**（`GitBranchMenu`），换分支就真的 checkout；
 *  3. 会话一旦建出来（第一条消息发出去）这一行就跟着消失 —— 它只属于「还没发起的新会话」。
 *
 * 选完项目**不会立刻建会话**：只是记住「这条新会话放这儿」（`store.ts` 的 `newSession`），
 * 发第一条消息时才真去建（见 `ws.ts` 的 `createSessionAndSend`）—— 不然点一下下拉框
 * 就多一条空会话，正是用户抱怨的那种垃圾会话。
 *
 * 下拉框最后那两项解决的是「这次先不按常规来」：
 *  - 「＋ 新建项目」= 换一个目录当项目（复用侧栏那个对话框）；
 *  - 「💬 临时会话（不保存）」= 建成引擎的临时会话（pi 的 `--no-session`）：
 *    **只活在内存里，关掉就没了，也不进历史**。它**不改项目** —— 引擎必须有 cwd 才跑得动，
 *    目录仍继承上面选的那个，所以它不是「不在项目中工作」（两者不是同一个轴）。
 *    只有声明了 `ephemeralChat` 的引擎（目前是 pi）才画这一项。
 *
 * 开启「临时会话（不保存）」之后，**项目/分支那几颗整颗收起**（用户要求：临时会话不需要
 * 选项目），这一行只剩「💬 不保存」一颗 —— 点它取消勾选，项目胶囊就回来。这只是不让他选，
 * 目录仍用之前选好的那个（引擎必须有 cwd），所以那颗的 tooltip 照实写工作目录。
 */
export function NewSessionScope({
	workspace,
	ephemeral,
	onChange,
	onEphemeralChange,
}: {
	/**
	 * 这条新会话要落在哪个项目（绝对路径）。
	 * `null` = 还不知道（服务端那条兜底逻辑：没有项目时跟着自己的工作区走）——
	 * 界面上照实写「不在项目中工作」，不编一个项目名出来。
	 */
	workspace: string | null;
	/** 临时会话（不保存）：建会话时带 `ephemeral`，纯内存、不落盘 */
	ephemeral: boolean;
	onChange: (cwd: string | null) => void;
	onEphemeralChange: (ephemeral: boolean) => void;
}) {
	const t = useT();
	const { snapshot } = useAppState();
	const projectPrefs: ProjectPrefs = snapshot?.settings.projectPrefs ?? { order: [], pinned: [], aliases: {} };
	// 跟侧栏同一份排序 + 别名：下拉框里看到的顺序和名字，跟左边那一栏一字不差
	const projects = sortProjects(snapshot?.piProjects ?? [], projectPrefs).map((project) => ({
		cwd: project.cwd,
		label: projectPrefs.aliases[project.cwd] || project.name || basename(project.cwd) || project.cwd,
	}));
	// 下拉框里的清单 = 侧栏那一份项目（排序/别名跟左边一字不差）+ 「刚选的新目录」。
	// 为什么要把新目录也放进去：它还没进 `piProjects`（会话发出去之后服务端才认它是项目），
	// 但不在清单里的后果是重新打开下拉框时**一个 ✓ 也看不到**，用户会以为上一把没选中、
	// 又去选一遍。放进来之后它跟其它项目一样带 ✓，只是顺序排最前（刚选的就在眼前）。
	// 比较一律走归一化后的路径：workspace 可能是旧数据里的 `/a/b/`（见 normalizeCwd），
	// 而清单里的 cwd 是 `/a/b` —— 直接全等会让下拉框里出现「两个同名的 foo」，
	// 一个带 ✓ 一个不带。
	const chosenKey = workspace === null ? null : normalizeCwd(workspace);
	const isChosen = (cwd: string) => chosenKey !== null && normalizeCwd(cwd) === chosenKey;
	const chosenFresh = workspace !== null && !projects.some((project) => isChosen(project.cwd));
	const rows: Array<{ cwd: string; label: string; fresh: boolean }> = chosenFresh
		? [
				{ cwd: workspace, label: basename(workspace) || workspace, fresh: true },
				...projects.map((p) => ({ ...p, fresh: false })),
			]
		: projects.map((p) => ({ ...p, fresh: false }));
	// 胶囊上的名字从 `rows` 里查（而不是只查已有项目），所以刚选的新目录也能显示目录名，
	// 不会退回「选择项目」—— 用户明明选好了目录，再让他选一次就是在骗人。
	const current = rows.find((project) => isChosen(project.cwd)) ?? null;
	const git = useGitBranch(workspace);
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [branchAnchor, setBranchAnchor] = useState<HTMLButtonElement | null>(null);
	const [branchOpen, setBranchOpen] = useState(false);
	const [filter, setFilter] = useState("");
	/** 键盘上下键当前停在哪一条（-1 = 还没动，回车按第一条算） */
	const [activeIndex, setActiveIndex] = useState(-1);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	// 「临时会话（不保存）」：只有真能开临时会话的引擎（目前是 pi）才画这一项 / 这颗胶囊。
	// 否则点下去要么报一个看不懂的错、要么被引擎当成普通会话落盘 —— 两种都是在骗人。
	const canEphemeral = snapshot?.engineCapabilities.ephemeralChat === true;
	/**
	 * 临时会话（不保存）开着 = **这一行只剩「不保存」**，项目/分支那几颗整颗收起。
	 * 用户的话：「如果选的是临时会话，不需有项目的选择」—— 临时会话本来就是
	 * 「随手问一句就走」，先让他选项目等于多问一件他不关心的事。
	 *
	 * 注意这只是**不让他选**，不是「不在项目里跑」：引擎必须有 cwd 才动得起来，
	 * 目录仍用之前选/继承的那个（`workspace` 不动），所以「不保存」那颗的 tooltip
	 * 照实写着工作目录，不骗人。取消勾选就把项目胶囊放回来。
	 */
	const tempOnly = ephemeral && canEphemeral;

	const pick = (cwd: string | null) => {
		onChange(cwd);
		setOpen(false);
		setFilter("");
		setActiveIndex(-1);
	};
	// 搜项目：几十个项目时下拉框会长到滚不到底，按名字/路径过滤一下（本机过滤，不必问服务端）
	const needle = filter.trim().toLowerCase();
	const visible = needle
		? rows.filter(
				(project) => project.label.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle),
			)
		: rows;

	// 键盘选到看不见的那一条时，把清单滚到它 —— 但只滚清单本身（block: nearest 不会带动整页）
	useEffect(() => {
		if (activeIndex < 0) return;
		const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	return (
		<div className="new-session-scope">
			{tempOnly ? null : (
				<button
					type="button"
					ref={setAnchor}
					className={`new-scope-chip${current ? "" : " new-scope-chip-muted"}`}
					title={
						workspace ??
						t(
							"还没有项目：这条会话会跟在服务端的工作区里",
							"No project yet: this session stays in the server workspace",
						)
					}
					aria-haspopup="listbox"
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				>
					<span className="new-scope-icon" aria-hidden="true">
						<FolderIcon open={false} />
					</span>
					<span className="new-scope-label">{current?.label ?? t("选择项目", "Choose a project")}</span>
					<svg viewBox="0 0 16 16" className="new-scope-caret" aria-hidden="true">
						<path d="m4.4 6.4 3.6 3.6 3.6-3.6" />
					</svg>
				</button>
			)}
			{/*
			 * 「临时（不保存）」开着时的提示胶囊：**点了就关**。
			 * 为什么单独立一颗而不只靠下拉框里的✓：这一项一旦开了，丢内容的后果比选错项目重得多
			 * （关了会话就真没了），所以必须一直看得见，而且能一下取消。
			 * 临时会话期间它是**唯一一颗**（项目/分支都收起了），tooltip 里补上工作目录 ——
			 * 不让选项目不等于不在目录里跑，这一点得说得清楚。
			 */}
			{ephemeral && canEphemeral ? (
				<button
					type="button"
					className="new-scope-chip new-scope-chip-ephemeral"
					title={t(
						`临时会话：只活在内存里，关闭即消失（点一下取消）· 工作目录：${workspace ?? "跟服务端工作区"}`,
						`Temporary session: in-memory only, gone on close (click to cancel) · working dir: ${workspace ?? "server workspace"}`,
					)}
					onClick={() => onEphemeralChange(false)}
				>
					<span className="new-scope-label">
						{/* 临时会话期间它是唯一一颗，所以写成完整的一句话；平时当中项目下拉框里的一项时短一点就行 */}
						{tempOnly ? t("💬 临时会话（不保存）", "💬 Temp session (not saved)") : t("💬 不保存", "💬 Not saved")}
					</span>
				</button>
			) : null}
			{/*
			 * 分支：只对 git 仓库有用。`isRepo` 为假（不是仓库 / 机器上没装 git）就整颗不画 ——
			 * 留一颗「分支：无」既占地方又让人以为能点。
			 * 临时会话时也不画：切分支是对项目做的写操作，跟「随手问一句就走」不是一回事。
			 */}
			{git.isRepo && git.branch && !tempOnly ? (
				<button
					type="button"
					ref={setBranchAnchor}
					className="new-scope-chip"
					title={t(`当前分支：${git.branch}（点一下切换）`, `Current branch: ${git.branch} (click to switch)`)}
					aria-haspopup="menu"
					aria-expanded={branchOpen}
					onClick={() => setBranchOpen((value) => !value)}
				>
					{/* 分支图标跟文件区那枚标签同一套线条（两个圆点 + 一条曲线），不另画一个 */}
					<BranchIcon className="new-scope-icon new-scope-branch-icon" />
					<span className="new-scope-label">{git.branch}</span>
				</button>
			) : null}

			{open && anchor ? (
				<ProjectMenuPopover
					anchor={anchor}
					className="proj-menu new-scope-menu"
					/* 居中于上面那颗项目胶囊：它是窄胶囊，贴右边缘算出来的浮层会整个往左支出去，
					   看着像「没对准我点的地方」（与状态栏/顶栏那几套浮层同一套纪律）。 */
					align="center"
					style={{ width: Math.min(320, Math.max(220, anchor.getBoundingClientRect().width + 40)) }}
					onClose={() => {
						setOpen(false);
						setFilter("");
						setActiveIndex(-1);
					}}
				>
					{/*
					 * 三段结构：**搜索框钉在上面、清单自己滚、底部两项钉在下面**。
					 * 以前整块是一个滚动容器，项目一多就是两个毛病：
					 *  - 滚几下搜索框就跟着滚出去了，想改关键词得先滚回顶部；
					 *  - 「新建项目」排在清单最后，不滚到底根本看不到。
					 */}
					<input
						className="new-scope-search"
						value={filter}
						autoFocus
						placeholder={t("搜索项目", "Search projects")}
						aria-label={t("搜索项目", "Search projects")}
						onChange={(event) => {
							setFilter(event.target.value);
							setActiveIndex(-1);
						}}
						// 下拉框里的输入框：别让外面的快捷键 / 侧栏把键吃掉
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setOpen(false);
								setFilter("");
								setActiveIndex(-1);
							} else if (event.key === "ArrowDown") {
								event.preventDefault();
								setActiveIndex((index) => (visible.length === 0 ? -1 : Math.min(visible.length - 1, index + 1)));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setActiveIndex((index) => Math.max(0, index - 1));
							} else if (event.key === "Enter") {
								// 回车 = 选键盘停着的那条；没按过上下键就选第一条（搜完直接回车是最常用的路径）
								const target = visible[activeIndex >= 0 ? activeIndex : 0];
								if (target) pick(target.cwd);
							}
							event.stopPropagation();
						}}
					/>
					<div className="new-scope-list" ref={listRef}>
						{visible.map((project, index) => (
							<button
								type="button"
								key={project.cwd}
								data-index={index}
								className={`proj-menu-item files-root-option${isChosen(project.cwd) ? " files-root-option-on" : ""}${
									index === activeIndex ? " new-scope-item-active" : ""
								}`}
								title={
									project.fresh
										? t(
												`${project.cwd}（刚选的目录：发出第一条消息后才会成为项目）`,
												`${project.cwd} (just picked: becomes a project after the first message)`,
											)
										: project.cwd
								}
								onClick={() => pick(project.cwd)}
								onMouseEnter={() => setActiveIndex(index)}
							>
								<span className="files-root-check" aria-hidden="true">
									{isChosen(project.cwd) ? "✓" : ""}
								</span>
								<span className="new-scope-menu-icon" aria-hidden="true">
									<FolderIcon open={false} />
								</span>
								<span className="files-root-option-label">{project.label}</span>
							</button>
						))}
						{visible.length === 0 ? (
							<div className="new-scope-empty">
								{/*
								 * 两种「空」不是一回事，文案得分开（以前一律写「没有匹配的项目」——
								 * 一个项目都还没有的人看到这句，会以为自己搜错了词）：
								 *  - 搜了但没命中 → 叫他换个词；
								 *  - 根本没有项目 → 告诉他下一步点哪里，并说清楚会落在哪儿。
								 */}
								{needle
									? t("没有匹配的项目", "No matching project")
									: t(
											"还没有任何项目：点下面的「新建项目」选一个目录。",
											"No projects yet — pick a folder with “New project” below.",
										)}
							</div>
						) : null}
					</div>
					{/*
					 * 底部动作区：**不跟清单一起滚**。项目再多，「新建项目」也一直在眼前。
					 * 图标槽跟上面每一行对齐（folder-plus），不然文字会突元地往左顶一格。
					 */}
					<div className="new-scope-foot">
						<button
							type="button"
							className="proj-menu-item files-root-option"
							onClick={() => {
								setOpen(false);
								setFilter("");
								setActiveIndex(-1);
								setNewProjectOpen(true);
							}}
						>
							<span className="files-root-check" aria-hidden="true" />
							<span className="new-scope-menu-icon" aria-hidden="true">
								<FolderPlusIcon />
							</span>
							<span className="files-root-option-label">{t("新建项目", "New project")}</span>
						</button>
						{canEphemeral ? (
							/*
							 * 「临时会话（不保存）」：勾上就建成引擎的临时会话（pi 的 `--no-session`）。
							 * 它不是「不在项目中工作」—— 目录仍继承上面选的项目，只是不落盘。
							 */
							<button
								type="button"
								className={`proj-menu-item files-root-option${ephemeral ? " files-root-option-on" : ""}`}
								title={t(
									"建成临时会话：不写会话文件、不进历史，关闭即消失（目录仍用上面选的项目）",
									"Create a temporary session: no session file, not in history, gone on close (still uses the project above)",
								)}
								onClick={() => {
									onEphemeralChange(!ephemeral);
									setOpen(false);
									setFilter("");
									setActiveIndex(-1);
								}}
							>
								<span className="files-root-check" aria-hidden="true">
									{ephemeral ? "✓" : ""}
								</span>
								{/*
								 * 💬 要落在**图标那一格**，不能塞进文字里：
								 * 塞文字里时它比上一行「新建项目」的 folder-plus 右移了整整一格（14px + 间距），
								 * 两行的图标看着就不在同一列，文字起点也跟着错开（用户提的「对齐一下」）。
								 * 图标本身仍是全站那一枚 💬（跟顶栏「临时会话」那颗、提示条同一个），不另换 svg。
								 */}
								<span className="new-scope-menu-icon new-scope-menu-icon-emoji" aria-hidden="true">
									💬
								</span>
								<span className="files-root-option-label">
									{t("临时会话（不保存）", "Temporary session (not saved)")}
								</span>
							</button>
						) : null}
					</div>
				</ProjectMenuPopover>
			) : null}

			{branchOpen && branchAnchor ? (
				<GitBranchMenu anchor={branchAnchor} git={git} align="center" onClose={() => setBranchOpen(false)} />
			) : null}

			{/*
			 * 「新建项目」直接复用侧栏那个对话框：它建完目录后会调 `onPick`。
			 * 这里传 `onChange`，于是「建一个新项目」= 把这条**还没提交**的会话指向它，
			 * 而不是像侧栏那样立刻建一条会话出来。
			 */}
			{newProjectOpen ? (
				<NewProjectDialog
					onClose={() => setNewProjectOpen(false)}
					onPick={(cwd) => {
						onChange(cwd);
						setNewProjectOpen(false);
					}}
				/>
			) : null}
		</div>
	);
}
