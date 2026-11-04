/**
 * 文件管理树里右键弹出的菜单（和 VSCode 资源管理器那一组对齐）。
 *
 * 目录：在文件夹中显示 · 在集成终端中打开 · 添加到对话 · 改动过的文件 · 在文件夹中查找…
 * 文件：在文件夹中显示 · 添加到对话 · 在所在文件夹中查找…
 *
 * 定位 / 关闭复用 ProjectMenuPopover（portal + fixed + 贴边翻转 + 点外面 / Esc 关），
 * 样式沿用 `proj-menu` + `ctx-menu`，跟文件预览里的右键菜单同一套长相。
 */
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";

export function FileTreeMenu({
	point,
	isDir,
	onReveal,
	onTerminal,
	onAddToConversation,
	onChanges,
	changesOnly = false,
	onFind,
	onClose,
}: {
	point: MenuPoint;
	/** 右键的是目录（目录多一项「在集成终端中打开」，文件则「查找」落在它所在的文件夹） */
	isDir: boolean;
	onReveal: () => void;
	/** 不传 = 这一处没有终端入口，就不画这一项 */
	onTerminal?: () => void;
	onAddToConversation: () => void;
	/** 「改动过的文件 / 所有文件」的切换。不传 = 这一处没有这一项 */
	onChanges?: () => void;
	/** 当前已经在「改动过的文件」模式里：文案变成「所有文件」 */
	changesOnly?: boolean;
	/** 不传 = 这一处没有内容搜索入口，就不画这一项 */
	onFind?: () => void;
	onClose: () => void;
}) {
	const t = useT();
	/** 点一项：先干活、再关菜单（和文件预览的右键菜单同一个节奏） */
	const run = (action: () => void) => () => {
		action();
		onClose();
	};
	return (
		<ProjectMenuPopover point={point} className="proj-menu ctx-menu" onClose={onClose}>
			<button type="button" className="proj-menu-item" onClick={run(onReveal)}>
				{t("在文件夹中显示", "Show in folder")}
			</button>
			{isDir && onTerminal ? (
				<button type="button" className="proj-menu-item" onClick={run(onTerminal)}>
					{t("在集成终端中打开", "Open in integrated terminal")}
				</button>
			) : null}
			<button type="button" className="proj-menu-item" onClick={run(onAddToConversation)}>
				{t("添加到对话", "Add to conversation")}
			</button>
			{onChanges ? (
				<button type="button" className="proj-menu-item" onClick={run(onChanges)}>
					{changesOnly ? t("所有文件", "All files") : t("改动过的文件", "Changed files")}
				</button>
			) : null}
			{onFind ? (
				<>
					<div className="proj-menu-sep" aria-hidden="true" />
					<button type="button" className="proj-menu-item" onClick={run(onFind)}>
						{isDir ? t("在文件夹中查找…", "Find in folder…") : t("在所在文件夹中查找…", "Find in its folder…")}
					</button>
				</>
			) : null}
		</ProjectMenuPopover>
	);
}
