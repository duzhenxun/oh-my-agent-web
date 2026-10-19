import { FileTree } from "./FileTree.tsx";

/**
 * 侧栏底部的「文件」区（从 Sidebar 里抽出来：400 行护栏）。
 *
 * 默认收起，只有一行标题；展开后：项目下拉独占一行，下面才是文件树。
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
}: {
	open: boolean;
	onToggle: () => void;
	height: number;
	root: string | null;
	onRootChange: (cwd: string | null) => void;
	options: { cwd: string; label: string }[];
	onOpenFile: (path: string) => void;
	onOpenTerminal: () => void;
}) {
	return (
		<section className={`side-files${open ? "" : " side-files-closed"}`} style={{ height: open ? height : undefined }}>
			<div className="side-files-head">
				<button
					type="button"
					className="project-collapse-all side-files-toggle"
					onClick={onToggle}
					title={open ? "收起文件管理" : "展开文件管理"}
				>
					{open ? "⌄" : "›"}
				</button>
				<span className="side-files-title">文件管理</span>
				<button type="button" className="side-files-term" title="在右侧打开当前项目的终端" onClick={onOpenTerminal}>
					&gt;_
				</button>
			</div>
			{open ? (
				<>
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
					<div className="side-files-body">
						<FileTree root={root} onOpenFile={onOpenFile} />
					</div>
				</>
			) : null}
		</section>
	);
}
