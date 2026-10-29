import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PanelKey } from "../panel-order.ts";

const FLIP_MS = 180;

function measurePositions(root: HTMLDivElement): Map<PanelKey, number> {
	const positions = new Map<PanelKey, number>();
	for (const child of Array.from(root.children)) {
		if (!(child instanceof HTMLElement)) continue;
		const key = child.dataset.panelKey as PanelKey | undefined;
		if (key) positions.set(key, child.offsetLeft);
	}
	return positions;
}

/** 当前 WAAPI / CSS transform 里的水平位移；用于接续上一次尚未播完的动画。 */
function currentTranslateX(element: HTMLElement): number {
	const transform = window.getComputedStyle(element).transform;
	if (!transform || transform === "none") return 0;
	try {
		return new DOMMatrixReadOnly(transform).m41;
	} catch {
		return 0;
	}
}

/**
 * 顶栏的顺序跟随弹窗变化时，用 FLIP 从旧位置滑到新位置，而不是瞬移。
 * offsetLeft 不受 transform 影响，所以记录到的始终是布局槽位，不会把动画位移误算进去。
 */
export function PanelOrderRow({
	order,
	className,
	children,
}: {
	order: readonly PanelKey[];
	className: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const previous = useRef(new Map<PanelKey, number>());
	const resizeObserver = useRef<ResizeObserver | null>(null);
	const orderKey = order.join("|");

	// 窗口宽度、语言或入口显隐改变了槽位时，只刷新基线，不把响应式布局变化当成排序动画。
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const observer = new ResizeObserver(() => {
			previous.current = measurePositions(root);
		});
		resizeObserver.current = observer;
		observer.observe(root);
		for (const child of Array.from(root.children)) observer.observe(child);
		return () => {
			observer.disconnect();
			resizeObserver.current = null;
		};
	}, []);

	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const next = new Map<PanelKey, number>();
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const child of Array.from(root.children)) {
			if (!(child instanceof HTMLElement)) continue;
			resizeObserver.current?.observe(child);
			const key = child.dataset.panelKey as PanelKey | undefined;
			if (!key) continue;
			const left = child.offsetLeft;
			next.set(key, left);
			const oldLeft = previous.current.get(key);
			if (oldLeft === undefined) continue;
			const inFlight = currentTranslateX(child);
			for (const animation of child.getAnimations()) animation.cancel();
			const delta = oldLeft + inFlight - left;
			if (!reduced && Math.abs(delta) > 0.5) {
				child.animate([{ transform: `translate3d(${delta}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }], {
					duration: FLIP_MS,
					easing: "cubic-bezier(0.2, 0, 0, 1)",
				});
			}
		}
		previous.current = next;
	}, [orderKey]);

	return (
		<div ref={ref} className={className}>
			{children}
		</div>
	);
}
