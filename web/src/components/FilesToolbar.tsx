/**
 * 「文件管理」标题栏右侧那排小按钮（`>_` 终端 · 📁 在 Finder 中显示 · 👁 隐藏文件 · 🔍 搜索），
 * 外加下拉框右边的 git 分支标签（点开是分支菜单）、下拉框下面的搜索框与结果列表。
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
import { useState } from "react";
import type { FileSearch } from "../use-file-search.ts";
import type { GitBranchControl } from "../use-git-branch.ts";
import type { FileSearchEntry } from "../use-file-search.ts";
import { GitBranchMenu } from "./GitBranchMenu.tsx";

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
	search,
}: {
	root: string | null;
	showHidden: boolean;
	onToggleHidden: () => void;
	onOpenTerminal: () => void;
	onReveal: () => void;
	/** 搜索框的开关与状态（搜索框本体在下拉框下面，不在这里） */
	search: FileSearch;
}) {
	return (
		<div className="files-toolbar">
			<button type="button" className="files-tool" title="在右侧打开终端" onClick={onOpenTerminal}>
				&gt;_
			</button>
			<button type="button" className="files-tool" title="在 Finder 中显示这个目录" onClick={onReveal} disabled={!root}>
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
			<button
				type="button"
				className={`files-tool${showHidden ? " files-tool-on" : ""}`}
				title={showHidden ? "隐藏点开头的文件" : "显示隐藏文件（.env 等）"}
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
			<button
				type="button"
				className={`files-tool${search.active ? " files-tool-on" : ""}`}
				title="按文件名搜索"
				aria-pressed={search.active}
				onClick={search.toggle}
				disabled={!root}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
					<path d="m10.2 10.2 3.2 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
				</svg>
			</button>
		</div>
	);
}

/** 搜索框本体：独占一行，放在项目下拉框下面 */
export function FilesSearchInput({ search }: { search: FileSearch }) {
	return (
		<input
			ref={search.inputRef}
			className="files-search"
			value={search.query}
			placeholder="搜索文件名…"
			onChange={(event) => search.setQuery(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Escape") search.close();
			}}
		/>
	);
}

/** 搜索结果列表：有关键字时顶替文件树 */
export function FilesSearchResults({
	entries,
	truncated,
	onOpenFile,
}: {
	entries: FileSearchEntry[];
	truncated: boolean;
	onOpenFile: (path: string) => void;
}) {
	const grouped = entries.slice(0, 60);
	if (entries.length === 0) return <div className="side-panel-hint">没有匹配的文件名</div>;
	return (
		<div className="files-search-list">
			{grouped.map((entry) => (
				<button
					type="button"
					key={entry.path}
					className="files-search-row"
					title={entry.path}
					onClick={() => (entry.isDir ? undefined : onOpenFile(entry.path))}
				>
					<span className="files-search-name">{entry.name}</span>
					<span className="files-search-path">{entry.path.split("/").slice(0, -1).join("/")}</span>
				</button>
			))}
			{truncated ? <div className="files-search-more">结果太多，只显示前 200 个</div> : null}
		</div>
	);
}
