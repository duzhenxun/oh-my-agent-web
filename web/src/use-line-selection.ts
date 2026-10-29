/**
 * 文件预览里的「行选区」状态（原本是 anchor/focus 两个 state，只能选一段）。
 *
 * 为什么要升级成多段：看代码时常常要引几处**不相邻**的行（比如把一个 if 分支和它的
 * 另一个分支一起丢给模型）。单段选区做不到，于是：
 *   - 普通点：只选这一行（清掉之前的）；
 *   - Shift+点：从锚点连成一段（跟编辑器一样）；
 *   - Ctrl / Cmd+点：把这一行**加进去**（再点一次就取消这一行）。
 * 相邻的段会合并，所以「Ctrl 点一堆连续行」等价于一次范围选择。
 */
import { useCallback, useRef, useState } from "react";
import { mergeRanges, normalizeRange, type LineRange, type LineSelection } from "./file-preview.ts";

type LineSelectionApi = {
	selection: LineSelection;
	/** 某一行（1-based）是否选中 */
	has: (line: number) => boolean;
	/** 点行：`index` 是 0-based 行号，`toggle` = 按住 Ctrl/Cmd */
	click: (index: number, modifiers: { shift?: boolean; toggle?: boolean }) => void;
	clear: () => void;
	/** 直接换成这一段（右键菜单「只追加这一行」之类用得上） */
	set: (range: LineRange) => void;
};

/** @param resetKey 换文件时清空（行号对不上旧的，留着只会误导） */
export function useLineSelection(resetKey: string): LineSelectionApi {
	const [selection, setSelection] = useState<LineSelection>([]);
	/** Shift 的锚点（0-based）；null = 还没点过 */
	const anchor = useRef<number | null>(null);
	const lastKey = useRef(resetKey);
	if (lastKey.current !== resetKey) {
		// 换文件：渲染期直接重置（不塞进 effect，避免先闪一帧旧选区）
		lastKey.current = resetKey;
		anchor.current = null;
		setSelection([]);
	}

	const click = useCallback((index: number, modifiers: { shift?: boolean; toggle?: boolean }) => {
		const line = index + 1;
		if (modifiers.toggle) {
			setSelection((current) => {
				const single = current.find((range) => range.start === line && range.end === line);
				// 再点一次取消这一行；否则加进去（相邻的会被 mergeRanges 合起来）
				if (single) return current.filter((range) => range !== single);
				return mergeRanges([...current, { start: line, end: line }]);
			});
			anchor.current = index;
			return;
		}
		if (modifiers.shift && anchor.current !== null) {
			const from = anchor.current;
			setSelection((current) => {
				const anchorLine = from + 1;
				// 锚点所在的那一段跟着伸缩：先把它摘掉，再按 锚点..index 重新铺一段
				const rest = current.filter((range) => !(range.start <= anchorLine && anchorLine <= range.end));
				return mergeRanges([...rest, normalizeRange(from, index)]);
			});
			return;
		}
		anchor.current = index;
		setSelection([{ start: line, end: line }]);
	}, []);

	const clear = useCallback(() => {
		anchor.current = null;
		setSelection([]);
	}, []);

	const set = useCallback((range: LineRange) => {
		anchor.current = range.start - 1;
		setSelection([{ ...range }]);
	}, []);

	return {
		selection,
		has: (line) => selection.some((range) => line >= range.start && line <= range.end),
		click,
		clear,
		set,
	};
}
