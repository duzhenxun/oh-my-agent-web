/**
 * 文件预览里右键弹出的「追加到对话」菜单。
 *
 * 三个来源都能追加，按「用户刚做过什么」排序，永远只有一两项是「这次想要的」：
 *   1. 自己点出来的多段选区（Ctrl+点那些）→ 一起追加；
 *   2. 鼠标拖出来的原生文字选择跨了行 → 追加那几行；
 *   3. 什么都没有 → 就追加右键点到的这一行。
 *
 * 另外带两项**折叠**动作（2026-10-30 加的）：「展开 / 收起这一块」。源码默认只展开一层，
 * 要一层层点下去太碎，右键一下就把当前这块（含里面嵌套的）全展开或全收起。
 *
 * 定位/关闭复用 ProjectMenuPopover（portal + fixed + 贴边翻转 + 点外面/Esc 关），
 * 只是把宽度放开一点：中文标签比「重命名」长得多。
 */
import { copyText } from "../clipboard.ts";
import {
	selectionLines,
	type BlockFoldState,
	type FoldRange,
	type LineRange,
	type LineSelection,
} from "../file-preview.ts";
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
	block,
	blockState,
	onExpandBlock,
	onCollapseBlock,
	onFind,
	blockText,
	blockFolded,
	onAddBlock,
	onClose,
}: {
	state: FileLineMenuState;
	appSelection: LineSelection;
	onAddSelection: () => void;
	onAddRange: (range: LineRange) => void;
	onClearSelection: () => void;
	/** 右键点到的这一行所在的块（`blockAt` 的结果）；null = 不在任何块里，折叠那项就不画 */
	block: FoldRange | null;
	/** 这块当前的折叠状态：决定只摆出「展开」还是「收起」（两个不会同时出现） */
	blockState: BlockFoldState | null;
	onExpandBlock: (block: FoldRange) => void;
	onCollapseBlock: (block: FoldRange) => void;
	/** 「查找」：把查词框叫出来（拖选过文字就带上那一段当初始词） */
	onFind: (preset: string) => void;
	/** 右键那行所在块的**原文**（含折叠看不见的那些行）：空串 = 不在块里，就不摆「复制这一块」 */
	blockText: string;
	/** 这块现在是收起的吗：收起时特别有用（里面的行鼠标根本选不到） */
	blockFolded: boolean;
	/** 「把这一块代码加到对话」：整块原文（含折叠的行）贴进草稿，见 file-preview.ts 的 codeSnippet */
	onAddBlock: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const drag = state.dragRange;
	const hasSelection = appSelection.length > 0;
	return (
		<ProjectMenuPopover point={state.point} className="proj-menu ctx-menu" onClose={onClose}>
			{/* 折叠那一项：按状态**只摆一个**。作用范围写进文案里（第 a–b 行），点了才知道发生了什么。 */}
			{block && blockState ? (
				<>
					<button
						type="button"
						className="proj-menu-item"
						onClick={() => {
							if (blockState === "open") onCollapseBlock(block);
							else onExpandBlock(block);
							onClose();
						}}
					>
						{blockState === "open" ? "⌃ " : "⌄ "}
						{blockState === "open"
							? t("收起这一块", "Collapse this block")
							: blockState === "partial"
								? t("展开里面全部", "Expand everything inside")
								: t("展开这一块", "Expand this block")}
						（{t(`第 ${block.start + 1}–${block.end + 1} 行`, `lines ${block.start + 1}–${block.end + 1}`)}）
					</button>
					<div className="proj-menu-sep" aria-hidden="true" />
				</>
			) : null}
			{/* 查找也摆在这一组：它跟折叠一样是「对着这块代码做的事」，而不是往对话里塞东西 */}
			<button
				type="button"
				className="proj-menu-item"
				onClick={() => {
					onFind(drag && drag.start !== drag.end ? state.dragText.trim() : "");
					onClose();
				}}
			>
				⌕{" "}
				{drag && drag.start !== drag.end && state.dragText.trim() !== ""
					? t("查找选中的文字", "Find the selected text")
					: t("查找…", "Find…")}
			</button>
			{/* 复制这一块代码：收起的时候特别需要 —— 里面那几十行在屏幕上根本选不到，
			    右键一下就把整块原文（含折叠的行）拿走。展开时也能用，省得手动拖选。 */}
			{block && blockText.trim() !== "" ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						void copyText(blockText);
						onClose();
					}}
				>
					⧉ {t("复制这一块代码", "Copy this block")}（
					{t(`第 ${block.start + 1}–${block.end + 1} 行`, `lines ${block.start + 1}–${block.end + 1}`)}
					{blockFolded ? t("，含收起的部分", ", including the collapsed part") : ""}）
				</button>
			) : null}
			{block && blockState ? <div className="proj-menu-sep" aria-hidden="true" /> : null}
			{/* 整块代码进对话：和右键「复制这一块代码」拿到的是同一份内容 ——
			    收起的那些行在屏幕上选不到，只给一个行范围引用的话，模型还得自己去 read 一遍。 */}
			{block && blockText.trim() !== "" ? (
				<button
					type="button"
					className="proj-menu-item"
					onClick={() => {
						onAddBlock();
						onClose();
					}}
				>
					⤴ {t("添加这一块代码到对话", "Add this block to the conversation")}（
					{t(`第 ${block.start + 1}–${block.end + 1} 行`, `lines ${block.start + 1}–${block.end + 1}`)}
					{blockFolded ? t("，含收起的部分", ", including the collapsed part") : ""}）
				</button>
			) : null}
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
