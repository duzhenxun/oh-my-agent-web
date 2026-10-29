/**
 * 右侧分栏里的「文件」页：就是把侧栏那棵树搬过来（宽一点更好点）。
 *
 * 为什么单独一个页而不是直接复用侧栏那块：侧栏的 `SidebarFiles` 自带标题栏、项目下拉框、
 * 高度拖拽与「收起」，绑在侧栏布局里；这里只要「树 + 点开进标签」，所以直接挂 `FileTree`。
 * 点文件仍然走主界面的 `openFileInPanel`（同一个标签体系，不会出现两份预览）。
 */
import { useState } from "react";
import { FileTree } from "./FileTree.tsx";
import { useT } from "../use-language.ts";

export function FilesTool({ root, onOpenFile }: { root: string | null; onOpenFile: (path: string) => void }) {
	const t = useT();
	const [showHidden, setShowHidden] = useState(false);
	const [refreshSeq, setRefreshSeq] = useState(0);

	return (
		<div className="work-files">
			<div className="work-files-head">
				<span className="work-files-root" title={root ?? undefined}>
					{root ?? t("（还没有工作区）", "(no workspace yet)")}
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
					title={t("刷新")}
				>
					↻
				</button>
			</div>
			<div className="work-files-body">
				<FileTree root={root} showHidden={showHidden} statusRevision={String(refreshSeq)} onOpenFile={onOpenFile} />
			</div>
		</div>
	);
}
