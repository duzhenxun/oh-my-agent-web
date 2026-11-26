import { FilesTool, type FilesToolProps } from "./FilesTool.tsx";
import { useT } from "../use-language.ts";

/**
 * 右侧面板里的「文件列表」侧栏：**常驻**在文件内容右边（不是一条标签）。
 *
 * 为什么单独做成侧栏而不是又一个标签：
 *   - 看代码时想换文件，如果文件树是标签，就得在「看代码」和「找文件」之间来回切，
 *     而这两件事本来就该同时看得见（IDE 里就是左边文件树、右边代码，我们反过来——
 *     面板本身贴在窗口右边，所以树在最右、内容在它左边）；
 *   - 它只认「我现在在看哪个文件」，不参与标签体系：关掉它不会关掉任何标签。
 *
 * 顶上那片「文件功能」**跟左边文件树是同一套**（用户 2026-11-25：
 * 「右侧文件预览区域，也把之前文件上面那些功能放在上面」）：
 * 刷新 / 显隐 / 按文件名搜 / 搜内容 / 改动清单 / 终端 / Finder，下面接项目下拉 + git 分支，再下面是树。
 *
 * 实现上**不另写一份**：直接挂 `FilesTool`（= `SidebarFiles` 的 panel 变体）。
 * 以前这里是简版（只有 👁 和 ↻ + 一个常驻筛选框），左边有的功能右边没有，
 * 用户回头就得在两个地方各记一套 —— 复用之后两边的差异只剩「壳」。
 */
export function FilesRail({
	root,
	activePath,
	onOpenFile,
	width,
	revealSeq = 0,
	files,
}: {
	/** 当前工作区。右树跟**正在看的这个文件**的根走（从别的项目点进来的标签也能定位） */
	root: string | null;
	/** 面板里正在看的文件：树上那一行加底色 */
	activePath: string | null;
	onOpenFile: (path: string) => void;
	/** 宽度（px）：由面板左边那条可拖的分隔线控制；不传就用 CSS 里那档默认值 */
	width?: number;
	/** 变化一次 = 把 `activePath` 展开 + 滚进视野（见 FileTree 的 `revealSeq`） */
	revealSeq?: number;
	/**
	 * 「文件」那一整套（工具条回调、项目下拉、git、搜索、改动清单、终端…）。
	 * 面板已经拿到了，这里接着用，不再往上一层加一堆零散的 prop。
	 */
	files: FilesToolProps;
}) {
	const t = useT();
	return (
		<aside className="preview-files" aria-label={t("文件列表", "File list")} style={width ? { width } : undefined}>
			<FilesTool
				{...files}
				/* 根、高亮、定位信号都要按**这根侧栏自己看的那份文件**来：
				   面板里的 `files.activePath` 是左树那一套，根可能对不上 */
				root={root}
				activePath={activePath}
				revealSeq={revealSeq}
				onOpenFile={onOpenFile}
			/>
		</aside>
	);
}
