import { useState } from "react";
import { FilesSearchInput, FilesSearchResults } from "./FilesToolbar.tsx";
import { FileTree } from "./FileTree.tsx";
import { useFileSearch } from "../use-file-search.ts";
import { useT } from "../use-language.ts";
import { basename } from "../path-utils.ts";

/**
 * 右侧面板里的「文件列表」侧栏：**常驻**在文件内容右边（不是一条标签）。
 *
 * 为什么单独做成侧栏而不是又一个标签：
 *   - 看代码时想换文件，如果文件树是标签，就得在「看代码」和「找文件」之间来回切，
 *     而这两件事本来就该同时看得见（IDE 里就是左边文件树、右边代码，我们反过来——
 *     面板本身贴在窗口右边，所以树在最右、内容在它左边）；
 *   - 它只认「我现在在看哪个文件」，不参与标签体系：关掉它不会关掉任何标签。
 *
 * 点树里的文件 → 走同一个 `onOpenFile`（= 面板的「新标签」），所以是在右边另开一个标签，
 * 已经开着的那份会被直接切过去（不会出现两份同一个文件）。
 */
export function FilesRail({
	root,
	activePath,
	onOpenFile,
	width,
	revealSeq = 0,
}: {
	/** 当前工作区（= 当前会话的项目根） */
	root: string | null;
	/** 面板里正在看的文件：树上那一行加底色 */
	activePath: string | null;
	onOpenFile: (path: string) => void;
	/** 宽度（px）：由面板左边那条可拖的分隔线控制；不传就用 CSS 里那档默认值 */
	width?: number;
	/** 变化一次 = 把 `activePath` 展开 + 滚进视野（见 FileTree 的 `revealSeq`） */
	revealSeq?: number;
}) {
	const t = useT();
	// 常驻筛选框：不靠 🔍 展开（见 use-file-search 的 always）
	const search = useFileSearch(root, { always: true });
	const [showHidden, setShowHidden] = useState(false);
	const [refreshSeq, setRefreshSeq] = useState(0);
	// 有输入就顶替文件树（跟侧栏那套同一个口径）
	const showResults = search.query.trim() !== "";
	const title = root ? basename(root) : t("文件", "Files");

	return (
		<aside className="preview-files" aria-label={t("文件列表", "File list")} style={width ? { width } : undefined}>
			<div className="preview-files-head">
				<span className="preview-files-title">
					<span className="preview-files-label">{t("文件列表", "Files")}</span>
					{/* 项目名跟在后面（只它自己省略号，不然窄面板上连「文件列表」几个字都被截掉）：
					    面板可能挂着好几个工作区，确认一下看的是哪一个 */}
					{root ? (
						<span className="preview-files-root" title={root}>
							{` · ${title}`}
						</span>
					) : null}
				</span>
				<button
					type="button"
					className={`btn btn-tiny${showHidden ? " btn-wide-on" : ""}`}
					onClick={() => setShowHidden((value) => !value)}
					title={t("显示隐藏文件", "Show hidden files")}
				>
					👁
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setRefreshSeq((value) => value + 1)}
					title={t("刷新（重新拉一次改动状态）", "Refresh (re-read the changes)")}
				>
					↻
				</button>
			</div>
			<FilesSearchInput search={search} placeholder={t("筛选文件…", "Filter files…")} />
			<div className="preview-files-body">
				{showResults ? (
					<FilesSearchResults
						entries={search.results}
						truncated={search.truncated}
						/* 右侧这根：点一条就开这个文件（树就在下面，不需要另外“定位”） */
						onPick={(entry) => {
							if (!entry.isDir) onOpenFile(entry.path);
						}}
					/>
				) : (
					<FileTree
						root={root}
						showHidden={showHidden}
						statusRevision={String(refreshSeq)}
						activePath={activePath}
						revealSeq={revealSeq}
						onNeedHidden={() => setShowHidden(true)}
						onOpenFile={onOpenFile}
					/>
				)}
			</div>
		</aside>
	);
}
