/**
 * 「上下拖动分隔条改高度」的小 hook（Sidebar 的文件区用它）。
 *
 * pointer 事件挂 document：鼠标移出分隔条范围也不会中断（和侧栏拖宽同一套做法）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useSplitHeight(options: {
	storageKey: string;
	initial: number;
	min: number;
	maxRatio?: number;
	/**
	 * 旧版本的默认值：用户在旧版里没拖过，存的也会是这个数。
	 * 命中就当成「没设过」，直接用新的 `initial` —— 否则改了默认值，老用户看不到变化。
	 */
	legacyDefaults?: number[];
}) {
	const [height, setHeight] = useState<number>(() => {
		const raw = Number(localStorage.getItem(options.storageKey));
		if (!Number.isFinite(raw) || raw < options.min) return options.initial;
		if (options.legacyDefaults?.includes(raw)) return options.initial;
		return raw;
	});
	const dragging = useRef(false);

	useEffect(() => {
		localStorage.setItem(options.storageKey, String(height));
	}, [options.storageKey, height]);

	const start = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			dragging.current = true;
			const startY = event.clientY;
			const startHeight = height;
			const max = Math.round(window.innerHeight * (options.maxRatio ?? 0.7));
			const onMove = (moveEvent: PointerEvent) => {
				if (!dragging.current) return;
				// 往上拖 = 变高
				setHeight(Math.min(Math.max(startHeight - (moveEvent.clientY - startY), options.min), max));
			};
			const onUp = () => {
				dragging.current = false;
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[height, options.maxRatio, options.min],
	);

	return { height, start, reset: () => setHeight(options.initial) };
}
