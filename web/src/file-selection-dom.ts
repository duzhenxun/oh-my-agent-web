/**
 * 鼠标拖出来的原生文字选择覆盖了哪几行、文字是什么（文件预览的右键菜单要它）。
 *
 * 为什么要单独算：拖选是浏览器自己的能力，我们只有一个 `window.getSelection()`；
 * 而每一行都带了 `data-line`（0-based），所以从选区两端的节点往上找最近的那一行即可。
 * 不在这个预览里 / 没有选区 → `range` 为 null（菜单就只给「追加这一行」）。
 */
import type { LineRange } from "./file-preview.ts";

export function draggedSelection(root: HTMLElement): { range: LineRange | null; text: string } {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { range: null, text: "" };
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return { range: null, text: "" };
	const lineOf = (node: Node | null): number | null => {
		const element = node instanceof Element ? node : (node?.parentElement ?? null);
		const row = element?.closest("[data-line]");
		const value = Number(row?.getAttribute("data-line"));
		return Number.isFinite(value) ? value + 1 : null;
	};
	const start = lineOf(range.startContainer);
	const end = lineOf(range.endContainer);
	const text = selection.toString();
	if (start === null || end === null) return { range: null, text };
	return { range: { start: Math.min(start, end), end: Math.max(start, end) }, text };
}
