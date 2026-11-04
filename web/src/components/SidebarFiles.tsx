import { useEffect, useState } from "react";
import { FileTree } from "./FileTree.tsx";
import { FilesSearchInput, FilesSearchResults, FilesToolbar, GitBranchTag } from "./FilesToolbar.tsx";
import { FilesRootSelect } from "./FilesRootSelect.tsx";
import { useFileSearch } from "../use-file-search.ts";
import { useGitBranch } from "../use-git-branch.ts";
import { useGitStatus } from "../use-git-status.ts";
import { useAppSelector } from "../store.ts";
import { useT } from "../use-language.ts";

/**
 * 侧栏底部的「文件」区（从 Sidebar 里抽出来：400 行护栏）。
 *
 * 默认收起，只有一行标题；展开后从上到下依次是：
 *   标题栏（三角 + 文件 + 那排小按钮）
 *   项目下拉框 + git 分支（分支在下拉框右边，点开可切分支）
 *   搜索框（点 🔍 才出现，在下拉框下面）
 *   文件树，或者有搜索关键字时的搜索结果列表
 */
export function SidebarFiles({
	open,
	onToggle,
	height,
	fill = false,
	root,
	onRootChange,
	options,
	onOpenFile,
	onOpenChangedFile,
	onOpenTerminal,
	onOpenBottomTerminal,
	onFindInFolder,
	onReveal,
	onSearchContents,
	activePath,
	revealSeq,
	revealPath,
	onRevealPath,
}: {
	open: boolean;
	onToggle: () => void;
	height: number;
	/** 撑满剩余高度（项目列表收起时用：文件树直接通到底，不留一块空白） */
	fill?: boolean;
	root: string | null;
	onRootChange: (cwd: string | null) => void;
	options: {
		cwd: string;
		label: string;
	}[];
	onOpenFile: (path: string) => void;
	/** 「改动过的文件」清单里点一个文件：以 diff 打开（默认看改动） */
	onOpenChangedFile?: (path: string) => void;
	onOpenTerminal: () => void;
	/** 文件树右键「在集成终端中打开」：传目录的绝对路径 */
	onOpenBottomTerminal?: (absDir: string) => void;
	/** 右键「在文件夹中查找」：传项目内的相对目录 */
	onFindInFolder?: (relDir: string) => void;
	/** 在 Finder 里定位某个目录（默认当前 root） */
	onReveal?: (cwd: string) => void;
	/** 搜**文件内容**：开全文搜索浮层（由 App 统一渲染） */
	onSearchContents?: () => void;
	/** 预览面板里正在看的那个文件：树上那一行高亮（“选中的就是它在看的那份”） */
	activePath?: string | null;
	/** 变化一次 = 把这个文件定位出来（展开祖先目录 + 滚进视野），见 FileTree 的 `revealSeq` */
	revealSeq?: number;
	/** 定位目标（默认跟 `activePath` 走）：文件名搜索里点了目录时，它是那个目录 */
	revealPath?: string | null;
	/** 请外面「在左树里定位这个路径」（加一次 revealSeq）；点搜索结果的目录时用 */
	onRevealPath?: (path: string) => void;
}) {
	const t = useT();
	/** 「眼睛」：是否列出点开头的隐藏文件（默认关，和系统文件管理器一致） */
	const [showHidden, setShowHidden] = useState(false);
	/** 「改动过的文件」模式：左边文件树只列 git 有改动的文件（右键菜单切换，见 FileTree） */
	const [changesOnly, setChangesOnly] = useState(false);
	/** 刷新：加一就重挂整棵树（重新从第一层列起） */
	const [refreshSeq, setRefreshSeq] = useState(0);
	const search = useFileSearch(root);
	const git = useGitBranch(root);
	/**
	 * 当前会话在跑没有：跑完（true → false）时让文件树重拉一次 git 状态 ——
	 * 智能体刚改过的文件，右侧的 M 得自动冒出来，不用手动点刷新。
	 */
	const snapshot = useAppSelector((state) => state.snapshot);
	const running =
		snapshot !== null &&
		snapshot.running.status !== "idle" &&
		snapshot.running.conversationId === snapshot.active.conversationId;

	// 收起时把搜索一起关掉：下次展开是文件树，不是一个残留在那儿的搜索框
	const { active: searching, close: closeSearch } = search;
	useEffect(() => {
		if (!open && searching) closeSearch();
	}, [open, searching, closeSearch]);

	const showResults = searching && search.query.trim() !== "";

	/**
	 * 改动过的文件（只用来决定**标题栏那颗 diff 图标要不要画**，以及它的数量提示）。
	 *
	 * 为什么这里再拉一次 `git status`（文件树自己那份还在用）：那颗图标长在标题栏，
	 * 而标题栏在 `FilesToolbar` 里，拿不到树内部的 hook 状态。多一次 `git status --porcelain`
	 * 就是几毫秒、而且只在「换分支 / 点刷新 / 一轮跑完」时发生，不值得为此把树的
	 * git 状态一路提升上来（那要改 FileTree 的 props 与所有取用点）。
	 */
	const gitStatus = useGitStatus(root, `${git.branch ?? ""}:${refreshSeq}`, running);
	const changedCount = Object.keys(gitStatus.entries).length;

	/**
	 * 点标题栏那颗 diff 图标：进「改动过的文件」，并**强制拉最新的**。
	 *
	 * 每次都加 `refreshSeq`（文件树会重挂 + 重拉状态表，标题栏这一份也会重拉），
	 * 所以在改动清单里连着点，就等于「再刷新一次」—— 在终端里刚 `git add`、智能体刚改完文件，
	 * 点一下看到的就是最新的，不用先去点左边的 ↻。
	 */
	const showChangedFiles = () => {
		// 收起状态下点它也要能看见结果：先把文件管理展开（那块没渲染，直接进模式等于没反应）
		if (!open) onToggle();
		setChangesOnly(true);
		setRefreshSeq((seq) => seq + 1);
		git.refresh();
	};

	/**
	 * 改动被清空（提交了 / 还原了）→ 自动退出清单模式。
	 *
	 * 不退出的话会卡在「改动过的文件 · 0」那一屏，而且那颗 diff 图标已经因为没改动而消失，
	 * 用户找不到回去的路（只剩右键菜单里那条「所有文件」）。
	 * 只在**确认是 git 仓库**之后才判（初始状态 isRepo=false，不能当成「没改动了」）。
	 */
	useEffect(() => {
		if (changesOnly && gitStatus.isRepo && changedCount === 0) setChangesOnly(false);
	}, [changesOnly, gitStatus.isRepo, changedCount]);

	return (
		<section
			className={`side-files${open ? "" : " side-files-closed"}${fill && open ? " side-files-fill" : ""}`}
			/* fill 时不写死高度：交给 flex 吃掉剩余空间 */
			style={{ height: open && !fill ? height : undefined }}
		>
			<div className="side-files-head">
				{/* 点「文件」这个标题开/关（标题本身就是一个按钮）。
				 * 三角跟上面「项目」用同一个类、同一个位置（都在**文字左边**）：两块标题的箭头尺寸、
				 * 旋转与间距一致；文字侧栏拉窄时走省略号，三角不被挤掉。 */}
				<button
					type="button"
					className="side-files-title"
					onClick={onToggle}
					title={open ? t("收起文件管理", "Collapse files") : t("展开文件管理", "Expand files")}
					aria-expanded={open}
				>
					<span className={`sidebar-title-caret${open ? " sidebar-title-caret-open" : ""}`} aria-hidden="true" />
					<span className="sidebar-title-label">{t("文件管理", "Files")}</span>
				</button>
				<FilesToolbar
					root={root}
					showHidden={showHidden}
					onToggleHidden={() => setShowHidden((value) => !value)}
					onOpenTerminal={onOpenTerminal}
					onReveal={() => root && onReveal?.(root)}
					onRefresh={() => {
						setRefreshSeq((seq) => seq + 1);
						// 分支也可能在别的终端里换过：顺手刷一下标签
						git.refresh();
					}}
					onSearchContents={() => onSearchContents?.()}
					search={search}
					changesOnly={changesOnly}
					changedCount={changedCount}
					onShowChanges={showChangedFiles}
				/>
				{/* 标题右边剩下的空白 = 同一个开关（跟「项目」那一行同一套，见 Sidebar.tsx）：
				 * 透明热区按钮铺满剩余宽度，图标位置一点不动；键盘 / 读屏仍走标题那颗。 */}
				<button type="button" className="sidebar-row-fill" aria-hidden="true" tabIndex={-1} onClick={onToggle} />
			</div>
			{open ? (
				<>
					<div className="side-files-select-row">
						{/* 自绘下拉（原生 <select> 点开是系统菜单，没法跟皮肤统一） */}
						<FilesRootSelect value={root ?? ""} options={options} onChange={onRootChange} />
						<GitBranchTag git={git} />
					</div>
					{searching ? <FilesSearchInput search={search} /> : null}
					<div className="side-files-body">
						{showResults ? (
							/*
							 * 点搜索结果 = **在左树里定位它**（用户要求：点完直接跳到那个文件/目录上）。
							 * 光开右侧预览不够 —— 结果列表是顶替文件树的，不收起它就什么也看不到。
							 *  - 文件：照旧开右侧预览（App 会同时把树根切对、发定位信号），再清掉关键字让树回来；
							 *  - 目录：只定位不开文件（没有“打开目录”这回事），树会把它自己展开。
							 * 清关键字而不关搜索框：想接着搜下一个词，输入框还在原地。
							 */
							<FilesSearchResults
								entries={search.results}
								truncated={search.truncated}
								onPick={(entry) => {
									if (entry.isDir) onRevealPath?.(entry.path);
									else onOpenFile(entry.path);
									search.setQuery("");
								}}
							/>
						) : (
							<FileTree
								/* 换分支 / 点刷新：用 key 重置文件树（否则看到的是旧分支或旧目录） */
								key={`${root ?? ""}:${git.branch ?? ""}:${refreshSeq}`}
								root={root}
								showHidden={showHidden}
								statusRevision={`${git.branch ?? ""}:${refreshSeq}`}
								running={running}
								activePath={activePath ?? null}
								revealSeq={revealSeq ?? 0}
								revealPath={revealPath ?? null}
								onNeedHidden={() => setShowHidden(true)}
								onOpenTerminalAt={onOpenBottomTerminal}
								onFindInFolder={onFindInFolder}
								changesOnly={changesOnly}
								onToggleChangesOnly={() => setChangesOnly((value) => !value)}
								onOpenFile={onOpenFile}
								onOpenChangedFile={onOpenChangedFile}
							/>
						)}
					</div>
				</>
			) : null}
		</section>
	);
}
