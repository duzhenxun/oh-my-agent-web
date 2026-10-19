/**
 * 「上下拖动分隔条改高度」的小 hook（Sidebar 的文件区用它）。
 *
 * pointer 事件挂 document：鼠标移出分隔条范围也不会中断（和侧栏拖宽同一套做法）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useSplitHeight(options: { storageKey: string; initial: number; min: number; maxRatio?: number }) {
	const [height, setHeight] = useState<number>(() => {
		const raw = Number(localStorage.getItem(options.storageKey));
		return Number.isFinite(raw) && raw >= options.min ? raw : options.initial;
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
