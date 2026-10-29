/**
 * 文件正文的逐行渲染（从 FilePreview 抽出来：那块模板本身就有 70 行，
 * 留在 FileViewer 里会把它顶过 400 行护栏，也不好读）。
 *
 * 只做「怎么画一行、点了算什么」，状态全在 FileViewer（选区 / 折叠 / 高亮）：
 * 折叠按「起始行 → 结束行」跳过内部行，嵌套按最大 end 跳过。
 */
import type { FoldRange } from "../file-preview.ts";
import { useT } from "../use-language.ts";

export function FileLines({
	lines,
	highlighted,
	folds,
	folded,
	isSelected,
	flashLine,
	onToggleFold,
	onPick,
	onAddLine,
}: {
	lines: string[];
	/** 逐行高亮后的 HTML（分批生成，没轮到的行是 undefined → 显示纯文本） */
	highlighted: (string | undefined)[];
	folds: FoldRange[];
	folded: Set<number>;
	isSelected: (line: number) => boolean;
	/** 刚跳过来的那一行（1-based）：亮一下就行，不当成「选中」 */
	flashLine?: number | null;
	onToggleFold: (index: number) => void;
	/** 点行：`toggle` = 按住 Ctrl/Cmd（加选），`shift` = 连选 */
	onPick: (
		index: number,
		modifiers: {
			shift?: boolean;
			toggle?: boolean;
		},
	) => void;
	/** 双击：把这一行的引用追加到对话 */
	onAddLine: (index: number) => void;
}) {
	const t = useT();
	/** 起始行 → 结束行 */
	const foldEnds = new Map(folds.map((fold) => [fold.start, fold.end]));
	let hideUntil = -1;
	return (
		<>
			{lines.map((line, index) => {
				if (index <= hideUntil) return null;
				const foldEnd = foldEnds.get(index);
				const canFold = foldEnd !== undefined && foldEnd > index;
				const isFolded = canFold && folded.has(index);
				if (isFolded) hideUntil = foldEnd;
				const selected = isSelected(index + 1);
				const html = highlighted[index];
				return (
					<div
						className={`file-preview-line file-preview-line-clickable${selected ? " file-preview-line-on" : ""}${
							flashLine === index + 1 ? " file-preview-line-focus" : ""
						}`}
						key={index}
						data-line={index}
						title={t("点选中这一行 · Shift+点连选 · Ctrl（Cmd）+点加选 · 右键追加到对话")}
						onClick={(event) => {
							const modifiers = { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey };
							// 用户正在拖选文字时不抢选择（否则复制粘贴会失效）。
							// 但 Shift+点 本身也会被浏览器当成「扩展文字选择」—— 那正是我们要的手势，
							// 所以 Shift 一律按行连选处理，并顺手把浏览器的文字选区清掉，免得两套高亮打架。
							if (!modifiers.shift && !window.getSelection()?.isCollapsed) return;
							if (modifiers.shift) window.getSelection()?.removeAllRanges();
							onPick(index, modifiers);
						}}
						onDoubleClick={() => onAddLine(index)}
					>
						{canFold ? (
							<button
								type="button"
								className={`file-fold${isFolded ? " file-fold-collapsed" : ""}`}
								title={isFolded ? "展开这一段" : "折叠这一段"}
								onClick={(event) => {
									event.stopPropagation();
									onToggleFold(index);
								}}
							>
								{isFolded ? "▸" : "▾"}
							</button>
						) : (
							<span className="file-fold file-fold-empty" aria-hidden="true" />
						)}
						<button
							type="button"
							className="file-preview-no"
							title={t("点选这一行（Shift+点连选，Ctrl/Cmd+点加选）")}
							onClick={(event) => {
								event.stopPropagation();
								onPick(index, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
							}}
						>
							{index + 1}
						</button>
						{html !== undefined ? (
							<span className="file-preview-text" dangerouslySetInnerHTML={{ __html: html || " " }} />
						) : (
							<span className="file-preview-text">{line || " "}</span>
						)}
						{isFolded && foldEnd !== undefined ? (
							<span className="file-fold-summary">⋯ {foldEnd - index} 行已折叠</span>
						) : null}
					</div>
				);
			})}
		</>
	);
}
