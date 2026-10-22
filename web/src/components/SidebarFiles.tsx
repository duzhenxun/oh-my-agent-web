import { useEffect, useState } from "react";
import { FileTree } from "./FileTree.tsx";
import { FilesSearchInput, FilesSearchResults, FilesToolbar, GitBranchTag } from "./FilesToolbar.tsx";
import { useFileSearch } from "../use-file-search.ts";
import { useGitBranch } from "../use-git-branch.ts";

/**
 * 侧栏底部的「文件」区（从 Sidebar 里抽出来：400 行护栏）。
 *
 * 默认收起，只有一行标题；展开后从上到下依次是：
 *   标题栏（三角 + 文件管理 + 那排小按钮）
 *   项目下拉框 + git 分支（分支在下拉框右边，点开可切分支）
 *   搜索框（点 🔍 才出现，在下拉框下面）
 *   文件树，或者有搜索关键字时的搜索结果列表
 */
export function SidebarFiles({
	open,
	onToggle,
	height,
	root,
	onRootChange,
	options,
	onOpenFile,
	onOpenTerminal,
	onReveal,
}: {
	open: boolean;
	onToggle: () => void;
	height: number;
	root: string | null;
	onRootChange: (cwd: string | null) => void;
	options: { cwd: string; label: string }[];
	onOpenFile: (path: string) => void;
	onOpenTerminal: () => void;
	/** 在 Finder 里定位某个目录（默认当前 root） */
	onReveal?: (cwd: string) => void;
}) {
	/** 「眼睛」：是否列出点开头的隐藏文件（默认关，和系统文件管理器一致） */
	const [showHidden, setShowHidden] = useState(false);
	const search = useFileSearch(root);
	const git = useGitBranch(root);

	// 收起时把搜索一起关掉：下次展开是文件树，不是一个残留在那儿的搜索框
	const { active: searching, close: closeSearch } = search;
	useEffect(() => {
		if (!open && searching) closeSearch();
	}, [open, searching, closeSearch]);

	const showResults = searching && search.query.trim() !== "";

	return (
		<section className={`side-files${open ? "" : " side-files-closed"}`} style={{ height: open ? height : undefined }}>
			<div className="side-files-head">
				{/* 不再放左侧三角：直接点「文件管理」这个标题开/关（标题本身就是一个按钮） */}
				<button
					type="button"
					className="side-files-title"
					onClick={onToggle}
					title={open ? "收起文件管理" : "展开文件管理"}
					aria-expanded={open}
				>
					文件管理
				</button>
				<FilesToolbar
					root={root}
					showHidden={showHidden}
					onToggleHidden={() => setShowHidden((value) => !value)}
					onOpenTerminal={onOpenTerminal}
					onReveal={() => root && onReveal?.(root)}
					search={search}
				/>
			</div>
			{open ? (
				<>
					<div className="side-files-select-row">
						<select
							className="side-files-select"
							value={root ?? ""}
							onChange={(event) => onRootChange(event.target.value || null)}
							title="切换项目"
						>
							<option value="">跟随当前会话</option>
							{options.map((option) => (
								<option key={option.cwd} value={option.cwd}>
									{option.label}
								</option>
							))}
						</select>
						<GitBranchTag git={git} />
					</div>
					{searching ? <FilesSearchInput search={search} /> : null}
					<div className="side-files-body">
						{showResults ? (
							<FilesSearchResults entries={search.results} truncated={search.truncated} onOpenFile={onOpenFile} />
						) : (
							<FileTree
								/* 换分支后文件可能变了：用 key 重置文件树（否则看到的是旧分支的列表） */
								key={`${root ?? ""}:${git.branch ?? ""}`}
								root={root}
								showHidden={showHidden}
								onOpenFile={onOpenFile}
							/>
						)}
					</div>
				</>
			) : null}
		</section>
	);
}
