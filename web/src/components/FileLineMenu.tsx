/**
 * 文件预览里右键弹出的「追加到对话」菜单。
 *
 * 三个来源都能追加，按「用户刚做过什么」排序，永远只有一两项是「这次想要的」：
 *   1. 自己点出来的多段选区（Ctrl+点那些）→ 一起追加；
 *   2. 鼠标拖出来的原生文字选择跨了行 → 追加那几行；
 *   3. 什么都没有 → 就追加右键点到的这一行。
 *
 * 定位/关闭复用 ProjectMenuPopover（portal + fixed + 贴边翻转 + 点外面/Esc 关），
 * 只是把宽度放开一点：中文标签比「重命名」长得多。
 */
import { copyText } from "../clipboard.ts";
import { selectionLines, type LineRange, type LineSelection } from "../file-preview.ts";
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";

export type FileLineMenuState = {
	point: MenuPoint;
	/** 右键点在第几行（1-based） */
	line: number;
	/** 鼠标拖选覆盖到的行范围（没拖 / 只在一行内拖 → null） */
	dragRange: LineRange | null;
	/** 拖选出来的文字（右键接管了浏览器菜单，得把「复制」还回去） */
	dragText: string;
};

export function FileLineMenu({
	state,
	appSelection,
	onAddSelection,
	onAddRange,
	onClearSelection,
	onClose,
}: {
	state: FileLineMenuState;
	appSelection: LineSelection;
	onAddSelection: () => void;
	onAddRange: (range: LineRange) => void;
	onClearSelection: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const drag = state.dragRange;
	const hasSelection = appSelection.length > 0;
	return (
		<ProjectMenuPopover point={state.point} className="proj-menu ctx-menu" onClose={onClose}>
			{hasSelection ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						onAddSelection();
						onClose();
					}}
				>
					⤴ {t("追加选中的", "Append the selected")} {selectionLines(appSelection)}{" "}
					{t("行到对话", "lines to the conversation")}
				</button>
			) : null}
			{drag && drag.start !== drag.end ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						onAddRange(drag);
						onClose();
					}}
				>
					⤴ {t("追加鼠标选中的第", "Append the dragged")} {drag.start}–{drag.end} {t("行", "lines")}
				</button>
			) : null}
			<button
				type="button"
				className="proj-menu-item"
				onClick={() => {
					onAddRange({ start: state.line, end: state.line });
					onClose();
				}}
			>
				⤴ {t("追加第", "Append line")} {state.line} {t("行到对话", "to the conversation")}
			</button>
			{state.dragText !== "" ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						// 原生右键菜单被我们接管了，把「复制」按原样还回去
						void copyText(state.dragText);
						onClose();
					}}
				>
					⧉ {t("复制选中的文字", "Copy the selected text")}
				</button>
			) : null}
			{hasSelection ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						onClearSelection();
						onClose();
					}}
				>
					{t("清空选中", "Clear selection")}
				</button>
			) : null}
		</ProjectMenuPopover>
	);
}
