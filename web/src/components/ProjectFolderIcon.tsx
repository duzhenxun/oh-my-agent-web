/**
 * 项目行前面的小图标：**收起 = 合着的文件夹，展开 = 打开的文件夹**。
 *
 * 以前是个旋转的小箭头，信息量低；文件夹的合/开更直观，也贴合「项目 = 目录」这件事。
 * 图标本体与文件树共用 `FolderIcon`（一份路径、一套描边），这里只负责外面那个 16px 的盒子
 * 和「展开时亮一点」的着色。
 */
import { FolderIcon } from "./FolderIcon.tsx";

export function ProjectFolderIcon({ open }: { open: boolean }) {
	return (
		<span className={`proj-chevron${open ? " proj-chevron-open" : ""}`} aria-hidden="true">
			<FolderIcon open={open} className="proj-folder" />
		</span>
	);
}
