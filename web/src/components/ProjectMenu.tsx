/**
 * 项目「⋯」菜单的内容（贴顶/移动/重命名/定位/终端/Finder）。
 *
 * 单独成文件的原因：菜单项有 7 个，塞回 Sidebar 会破 400 行护栏（ADR-0010）；
 * 定位（portal + fixed）在 ProjectMenuPopover 里，这里只管按钮与回调。
 */
import { ProjectMenuPopover } from "./ProjectMenuPopover.tsx";

export function ProjectMenu({
	anchor,
	onClose,
	pinned,
	onTogglePin,
	onMoveUp,
	onMoveDown,
	onRename,
	onOpenFiles,
	onOpenTerminal,
	onReveal,
	onDeleteAll,
	sessionCount,
}: {
	anchor: HTMLElement | null;
	onClose: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onRename: () => void;
	onOpenFiles: () => void;
	onOpenTerminal: () => void;
	onReveal: () => void;
	/** 删除这个项目下的全部会话（会二次确认） */
	onDeleteAll: () => void;
	/** 供菜单显示条数 */
	sessionCount: number;
}) {
	/** 点完就收菜单（每个动作都是「一锤子」） */
	const act = (fn: () => void) => () => {
		fn();
		onClose();
	};

	return (
		<ProjectMenuPopover anchor={anchor} onClose={onClose}>
			<button type="button" className="proj-menu-item" onClick={act(onTogglePin)}>
				{pinned ? "📌 取消置顶" : "📌 置顶项目"}
			</button>
			<button type="button" className="proj-menu-item" title="在同组内上移一格" onClick={act(onMoveUp)}>
				↑ 上移
			</button>
			<button type="button" className="proj-menu-item" title="在同组内下移一格" onClick={act(onMoveDown)}>
				↓ 下移
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onRename)}>
				✏️ 重命名…
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onOpenFiles)}>
				📁 在文件列表中定位
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onOpenTerminal)}>
				⌨ 在终端中打开
			</button>
			<button
				type="button"
				className="proj-menu-item"
				title="在系统文件管理器里定位这个目录（只定位，不执行任何文件）"
				onClick={act(onReveal)}
			>
				🔍 在 Finder 中显示
			</button>
			{/* 破坏性操作放最后、标红：删的是这条项目的全部会话（可确认、可从磁盘恢复） */}
			<button
				type="button"
				className="proj-menu-item proj-menu-danger"
				title="删除这个项目下的全部会话（文件改名成 .deleted-时间戳，可从磁盘恢复）"
				onClick={act(onDeleteAll)}
			>
				🗑 删除全部会话… · {sessionCount}
			</button>
		</ProjectMenuPopover>
	);
}
