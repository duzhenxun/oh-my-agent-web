import type { ComponentProps } from "react";
import { SidebarFiles } from "./SidebarFiles.tsx";

/**
 * 右侧分栏里的「文件」工具页。
 *
 * 用户 2026-11-23：「下面这个文件移动到工具里……移动过去时上面的小功能都要保留着」——
 * 所以这里**不重写一个简化版**，而是直接把侧栏那块（`SidebarFiles`）以 `variant="panel"`
 * 挂进来：工具栏（刷新 / 显隐 / 文件名搜索 / 改动清单 / 终端 / 在文件夹中显示）、
 * 项目下拉框 + git 分支、搜索结果、文件树（含右键菜单）全都原样带着。
 *
 * 少掉的只有「侧栏那一层壳」：折叠标题、标题右侧的透明热区、可拖的高度 ——
 * 在面板里它是常开的一整页，没有「收起」这回事。
 */
export type FilesToolProps = Omit<
	ComponentProps<typeof SidebarFiles>,
	"variant" | "open" | "onToggle" | "height" | "fill"
>;

export function FilesTool(props: FilesToolProps) {
	// `open` / `height` 是 `SidebarFiles` 那两个必填项：面板里恒为开、高度由 CSS 撑满
	return <SidebarFiles variant="panel" open height={0} onToggle={() => {}} {...props} />;
}
