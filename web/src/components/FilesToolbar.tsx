/**
 * 「文件管理」标题栏那排小按钮（紧跟标题，从左到右）：
 *   ↻ 刷新 · 👁 隐藏文件 · 🔍 按文件名搜 · ⌕̄ 搜文件内容 · `>_` 终端 · 📁 在 Finder 中显示
 * 刷新在最前：它是唯一直接对**这棵树**本身的操作；「终端 / 在 Finder 中显示」放最后：
 * 它们是把目录开到别处去，跟「看这棵树」不是一类动作。
 * 两把放大镜挨着（文件名 / 文件内容）：同一个问题「东西在哪」的两种问法，摆一起最好找。
 * 外加下拉框右边的 git 分支标签（点开是分支菜单）、下拉框下面的搜索框与结果列表。
 *
 * （原先第二颗是「⧉ 全部收起」：用户：「这里这个图标可以不要」—— 删了。
 * 它其实不常用：树里点开几层后想全收，直接点标题收起再展开也行，不必多占一个位置；
 * 连带的 `collapseSeq` 状态与 `FileTree` 里那段复位逻辑一起移除了。）
 *
 * 布局约定（用户要求）：
 *   标题栏  = 三角 + 「文件管理」+ 那排小按钮
 *   第二行  = 项目下拉框 + 分支标签（在它右边）
 *   第三行  = 搜索框（点 🔍 才出现）
 *   第四行  = 文件树 / 搜索结果
 *
 * 搜索与分支的状态都在 SidebarFiles 里（`useFileSearch` / `useGitBranch`），
 * 因为按钮和渲染位置分散在两行，状态必须放在共同父级。
 */
import { useState, type ReactNode } from "react";
import type { FileSearch } from "../use-file-search.ts";
import type { GitBranchControl } from "../use-git-branch.ts";
import type { FileSearchEntry } from "../use-file-search.ts";
import { GitBranchMenu } from "./GitBranchMenu.tsx";
import { useT } from "../use-language.ts";
import { formatCombo, isMacPlatform } from "../shortcuts.ts";
import { useShortcuts } from "../use-shortcuts.ts";

/**
 * 图标按钮的悬停提示。
 *
 * 气泡画在外层 span 上而不是按钮自己的 `title`：Chrome 对 `disabled` 的按钮不弹原生
 * title（元素收不到鼠标事件），项目没打开时那几个灰掉的图标就成了「看着有功能、问不出
 * 是什么」；原生气泡还要等一秒多，样式也不跟主题。
 */
function Tip({ text, children }: { text: string; children: ReactNode }) {
	return (
		<span className="files-tool-tip" data-tip={text}>
			{children}
		</span>
	);
}

function BranchIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="4.5" cy="3.6" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="4.5" cy="12.4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="11.5" cy="6.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<path
				d="M4.5 5.3v5.4M11.5 7.9c0 2-2.4 2-4.4 2.4"
				stroke="currentColor"
				strokeWidth="1.2"
				fill="none"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** git 分支标签：放在项目下拉框右边，点开是分支菜单；不是仓库时不渲染 */
export function GitBranchTag({ git }: { git: GitBranchControl }) {
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	if (!git.isRepo) return null;
	const name = git.branch ?? "detached";
	return (
		<>
			<button
				type="button"
				ref={setAnchor}
				className={`files-branch${open ? " files-branch-open" : ""}`}
				title={`当前 git 分支：${name}（点开切换）`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => {
					// 每次打开都刷一下：别的终端里刚 checkout 过的分支也能看见
					if (!open) git.refresh();
					setOpen((value) => !value);
				}}
			>
				<BranchIcon />
				{/* 文字必须自带一层：.files-branch 是 flex，text-overflow 对匿名文本项不生效（会硬切半个字） */}
				<span className="files-branch-name">{name}</span>
			</button>
			{open && anchor ? <GitBranchMenu anchor={anchor} git={git} onClose={() => setOpen(false)} /> : null}
		</>
	);
}

export function FilesToolbar({
	root,
	showHidden,
	onToggleHidden,
	onOpenTerminal,
	onReveal,
	onRefresh,
	onSearchContents,
	search,
}: {
	root: string | null;
	showHidden: boolean;
	onToggleHidden: () => void;
	onOpenTerminal: () => void;
	onReveal: () => void;
	/** 重新列一遍目录树（别的终端/编辑器刚加的文件也能看见） */
	onRefresh: () => void;
	/** 搜**文件内容**（全文搜索浮层，不在这条标题栏里展开） */
	onSearchContents: () => void;
	/** 搜索框的开关与状态（搜索框本体在下拉框下面，不在这里） */
	search: FileSearch;
}) {
	const t = useT();
	/**
	 * 搜索那颗按钮的提示带**当前绑定**（默认 ⌘⇧F / Ctrl+Shift+F）：
	 * 设置 → 快捷键 里改了键，这里的提示要跟着变 —— 写死的旧键比不写更让人困惑。
	 */
	const [shortcuts] = useShortcuts();
	const searchCombo = formatCombo(shortcuts.contentSearch, isMacPlatform());
	const searchHint = searchCombo ? `（${searchCombo}）` : "";
	const searchLabel = { zh: `搜索文件内容${searchHint}`, en: `Search file contents ${searchHint}` };
	return (
		<div className="files-toolbar">
			{/*
			 * 每个图标外面包一层 Tip：提示气泡画在**外层 span** 上。
			 *
			 * 为什么不直接给按钮写 title：Chrome 里 disabled 的按钮收不到鼠标事件，
			 * 原生 title 根本不弹（「没有项目时刷新/搜索全都灰着」正是这种情形）；
			 * 而且原生气泡要等一秒多、样式也不跟主题。包一层 span 之后，
			 * 禁用状态照样有提示，出现也快。
			 */}
			<Tip text={t("刷新文件列表", "Refresh the file list")}>
				{/* 刷新：整棵树重新列一遍（收起态也回到第一层，跟文件管理器里按 F5 一个意思） */}
				<button
					type="button"
					className="files-tool"
					aria-label={t("刷新文件列表", "Refresh the file list")}
					onClick={onRefresh}
					disabled={!root}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="M12.9 8a5.2 5.2 0 1 1-5.2-5.2c1.46 0 2.85.58 3.89 1.59L12.9 5.3"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
						<path
							d="M12.9 2.1v3.2h-3.2"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</Tip>
			<Tip
				text={
					showHidden
						? t("隐藏点开头的文件", "Hide dot-prefixed files")
						: t("显示隐藏文件（.env 等）", "Show hidden files (.env etc.)")
				}
			>
				<button
					type="button"
					className={`files-tool${showHidden ? " files-tool-on" : ""}`}
					aria-label={t("显示 / 隐藏以点开头的文件", "Show / hide dot-prefixed files")}
					aria-pressed={showHidden}
					onClick={onToggleHidden}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="M1.6 8s2.3-4 6.4-4 6.4 4 6.4 4-2.3 4-6.4 4S1.6 8 1.6 8Z"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.2"
							strokeLinejoin="round"
						/>
						<circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
					</svg>
				</button>
			</Tip>
			<Tip text={t("按文件名搜索", "Search by file name")}>
				<button
					type="button"
					className={`files-tool${search.active ? " files-tool-on" : ""}`}
					aria-label={t("按文件名搜索", "Search by file name")}
					aria-pressed={search.active}
					onClick={search.toggle}
					disabled={!root}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
						<path d="m10.2 10.2 3.2 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
					</svg>
				</button>
			</Tip>
			<Tip text={t(searchLabel.zh, searchLabel.en)}>
				{/* 搜**内容**：放大镜里裹一道横线（「在文件里面找」的意思）。
				    它开的是浮层（见 ContentSearch.tsx），不在这列下面展开 —— 结果要带行号 + 原文，
				    挤在侧栏里每行只剩二十来字。 */}
				<button
					type="button"
					className="files-tool"
					aria-label={t(searchLabel.zh, searchLabel.en)}
					onClick={onSearchContents}
					disabled={!root}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						{/* 左边三道横线 = 「文本文档」，右下角叠一把放大镜 = 「在文档里找」：
						    跟旁边那颗纯放大镜（搜文件名）一眼能分开 */}
						<path
							d="M2.4 3.2h8.2M2.4 6.1h8.2M2.4 9h4.6"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.25"
							strokeLinecap="round"
						/>
						<circle cx="10.3" cy="10.1" r="2.5" fill="var(--bg-elev)" stroke="currentColor" strokeWidth="1.3" />
						<path d="m12.2 12 2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
					</svg>
				</button>
			</Tip>
			{/* 终端 / Finder 这两个是「把目录开到别处去」的入口：手机上不要（见 styles/files-toolbar.css 的
			   手机段 —— 抽屉只有 2/3 宽，六个图标排不下；这两个在项目行的「⋯」菜单里也都有） */}
			<Tip text={t("在右侧打开终端", "Open a terminal on the right")}>
				<button
					type="button"
					className="files-tool files-tool-terminal"
					aria-label={t("在右侧打开终端", "Open a terminal on the right")}
					onClick={onOpenTerminal}
				>
					&gt;_
				</button>
			</Tip>
			<Tip text={t("在 Finder 中显示这个目录", "Reveal this folder in Finder")}>
				<button
					type="button"
					className="files-tool files-tool-reveal"
					aria-label={t("在 Finder 中显示这个目录", "Reveal this folder in Finder")}
					onClick={onReveal}
					disabled={!root}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="M1.8 4.3c0-.6.5-1.1 1.1-1.1h2.7l1.3 1.5h5.2c.6 0 1.1.5 1.1 1.1v5.5c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.3Z"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.2"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</Tip>
		</div>
	);
}

/** 搜索框本体：独占一行，放在项目下拉框下面（右侧面板那根常驻侧栏也用它，换个更贴切的提示词） */
export function FilesSearchInput({ search, placeholder }: { search: FileSearch; placeholder?: string }) {
	const t = useT();
	return (
		<input
			ref={search.inputRef}
			className="files-search"
			value={search.query}
			placeholder={placeholder ?? t("搜索文件名…")}
			onChange={(event) => search.setQuery(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Escape") search.close();
			}}
		/>
	);
}

/** 搜索结果列表：有关键字时顶替文件树。
 * **点一条干什么由调用方决定**（`onPick`）：左树里点一条 = 把它在树里定位出来（文件还顺带
 * 开右侧预览），右侧面板里的筛选栏点一条 = 直接开文件 —— 两边「点一下」的期望不一样。 */
export function FilesSearchResults({
	entries,
	truncated,
	onPick,
}: {
	entries: FileSearchEntry[];
	truncated: boolean;
	onPick: (entry: FileSearchEntry) => void;
}) {
	const t = useT();
	const grouped = entries.slice(0, 60);
	if (entries.length === 0) return <div className="side-panel-hint">{t("没有匹配的文件名")}</div>;
	return (
		<div className="files-search-list">
			{grouped.map((entry) => (
				<button
					type="button"
					key={entry.path}
					className="files-search-row"
					title={entry.path}
					onClick={() => onPick(entry)}
				>
					<span className="files-search-name">{entry.name}</span>
					<span className="files-search-path">{entry.path.split("/").slice(0, -1).join("/")}</span>
				</button>
			))}
			{truncated ? <div className="files-search-more">{t("结果太多，只显示前 200 个")}</div> : null}
		</div>
	);
}
