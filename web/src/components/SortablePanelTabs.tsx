import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { layoutPanelTabs, panelTabTargetIndex, type PanelTabBox } from "../panel-tab-dnd.ts";
import { movePanel, samePanelOrder, type PanelKey } from "../panel-order.ts";
import { useT } from "../use-language.ts";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { PanelIcon } from "./PanelIcon.tsx";

const DRAG_THRESHOLD = 5;
const SETTLE_MS = 180;
const DRAG_CLASS = "is-panel-tab-dragging";

type DragState = {
	key: PanelKey;
	baseOrder: PanelKey[];
	previewOrder: PanelKey[];
	boxes: Map<PanelKey, PanelTabBox>;
	gap: number;
	dx: number;
	phase: "dragging" | "settling";
};

/**
 * 弹窗顶部 Tab：Pointer Events 拖动排序，点击仍然只负责切换面板。
 *
 * 拖动时 DOM 暂不换位：拖动项跟手，其余 Tab 用 transform 让位；顺序同时发给父级，
 * 所以顶栏会实时预览同一个顺序。松手先滑入目标槽位，再撤掉临时 transform，
 * 此时 React 的真实顺序已经是预览顺序，不会发生「松手跳一下」。
 */
export function SortablePanelTabs({
	order,
	active,
	label,
	onSelect,
	onOrderChange,
	onHeadPointerDown,
	onHeadDoubleClick,
	headTitle,
}: {
	order: PanelKey[];
	active: PanelKey;
	label: (key: PanelKey) => string;
	onSelect: (key: PanelKey) => void;
	onOrderChange: (next: PanelKey[]) => void;
	onHeadPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onHeadDoubleClick: () => void;
	headTitle: string;
}) {
	const t = useT();
	const headRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const dragRef = useRef<DragState | null>(null);
	const cancelSession = useRef<(() => void) | null>(null);
	const settleTimer = useRef<number | null>(null);
	const suppressClick = useRef(false);
	const suppressTimer = useRef<number | null>(null);

	const updateDrag = (next: DragState | null) => {
		dragRef.current = next;
		setDrag(next);
	};

	useEffect(
		() => () => {
			cancelSession.current?.();
			if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
			if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
			document.documentElement.classList.remove(DRAG_CLASS);
		},
		[],
	);

	const start = (event: ReactPointerEvent<HTMLButtonElement>, key: PanelKey) => {
		// Tab 上的拖动用于排序，不能再冒泡成「移动整个弹窗」；头部空白处仍可移动弹窗。
		event.stopPropagation();
		if (event.button !== 0 || dragRef.current) return;
		/**
		 * 手机上这排 Tab 会换行成两排（responsive.css），而排序的槽位算法是**单行**的
		 * （只比横向位置）—— 两行时同一列的左右缘会撞在一起，拖起来顺序乱跳。
		 * 用户 2026-10-30：「手机上不需要更换他们的位置」→ 手机只响应点击，不启动排序。
		 */
		if (currentMobileShell()) return;

		const pointerId = event.pointerId;
		const button = event.currentTarget;
		const baseOrder = [...order];
		const startX = event.clientX;
		const startY = event.clientY;
		let latestX = startX;
		let latestY = startY;
		let started = false;
		let ended = false;
		let raf: number | null = null;
		let notifiedOrder = baseOrder;

		const notify = (next: PanelKey[]) => {
			if (samePanelOrder(notifiedOrder, next)) return;
			notifiedOrder = next;
			onOrderChange(next);
		};

		const applyMovement = () => {
			if (!started || ended) return;
			const current = dragRef.current;
			const draggedBox = current?.boxes.get(key);
			if (!current || !draggedBox) return;
			const dx = latestX - startX;
			const center = draggedBox.left + draggedBox.width / 2 + dx;
			const target = panelTabTargetIndex(baseOrder, key, center, current.boxes);
			const previewOrder = movePanel(baseOrder, key, target);
			updateDrag({ ...current, dx, previewOrder, phase: "dragging" });
			notify(previewOrder);
		};

		const finish = (cancelled: boolean) => {
			if (ended) return;
			ended = true;
			cleanup();
			const current = dragRef.current;
			if (!current) return;
			const previewOrder = cancelled ? current.baseOrder : current.previewOrder;
			notify(previewOrder);
			updateDrag({ ...current, previewOrder, phase: "settling" });

			// 拖完松手通常会合成一次 click；这次 click 不能再切走当前面板。
			suppressClick.current = true;
			if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
			suppressTimer.current = window.setTimeout(() => {
				suppressClick.current = false;
			}, 400);

			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			settleTimer.current = window.setTimeout(
				() => {
					settleTimer.current = null;
					updateDrag(null);
				},
				reduced ? 0 : SETTLE_MS,
			);
		};

		const onMove = (moveEvent: PointerEvent) => {
			if (moveEvent.pointerId !== pointerId || ended) return;
			latestX = moveEvent.clientX;
			latestY = moveEvent.clientY;
			if (!started) {
				const dx = latestX - startX;
				const dy = latestY - startY;
				if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return;
				// 触屏上的竖向手势留给页面滚动；明确的横向手势才进入排序。
				if (Math.abs(dy) > Math.abs(dx)) {
					cleanup();
					return;
				}
				const head = headRef.current;
				if (!head) return;
				const boxes = new Map<PanelKey, PanelTabBox>();
				for (const panelKey of baseOrder) {
					const node = head.querySelector<HTMLElement>(`[data-panel-key="${panelKey}"]`);
					if (!node) continue;
					const rect = node.getBoundingClientRect();
					boxes.set(panelKey, { left: rect.left, width: rect.width });
				}
				if (boxes.size !== baseOrder.length) {
					cleanup();
					return;
				}
				started = true;
				try {
					button.setPointerCapture(pointerId);
				} catch {
					// document 级监听已经能兜住；不支持 pointer capture 也不影响排序。
				}
				document.documentElement.classList.add(DRAG_CLASS);
				const gap = Number.parseFloat(window.getComputedStyle(head).columnGap) || 0;
				updateDrag({
					key,
					baseOrder,
					previewOrder: baseOrder,
					boxes,
					gap,
					dx,
					phase: "dragging",
				});
			}
			moveEvent.preventDefault();
			if (raf === null)
				raf = window.requestAnimationFrame(() => {
					raf = null;
					applyMovement();
				});
		};

		const onUp = (upEvent: PointerEvent) => {
			if (upEvent.pointerId !== pointerId || ended) return;
			if (!started) {
				cleanup();
				return;
			}
			upEvent.preventDefault();
			if (raf !== null) window.cancelAnimationFrame(raf);
			raf = null;
			applyMovement();
			finish(false);
		};

		const onCancel = (cancelEvent: PointerEvent) => {
			if (cancelEvent.pointerId !== pointerId || ended) return;
			if (!started) cleanup();
			else finish(true);
		};
		const onKeyDown = (keyEvent: KeyboardEvent) => {
			if (keyEvent.key !== "Escape") return;
			if (started) {
				keyEvent.preventDefault();
				finish(true);
			} else cleanup();
		};
		const onBlur = () => {
			if (started) finish(true);
			else cleanup();
		};

		function cleanup() {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onCancel);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", onBlur);
			if (raf !== null) window.cancelAnimationFrame(raf);
			raf = null;
			document.documentElement.classList.remove(DRAG_CLASS);
			try {
				if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
			} catch {
				// 指针可能已经被浏览器收回。
			}
			if (cancelSession.current === cleanup) cancelSession.current = null;
		}

		cancelSession.current?.();
		cancelSession.current = cleanup;
		document.addEventListener("pointermove", onMove, { passive: false });
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onCancel);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", onBlur);
	};

	const renderedOrder = drag?.baseOrder ?? order;
	const targetLayout = drag ? layoutPanelTabs(drag.previewOrder, drag.boxes, drag.gap) : null;
	const transformFor = (key: PanelKey): string | undefined => {
		if (!drag || !targetLayout) return undefined;
		const base = drag.boxes.get(key);
		const target = targetLayout.get(key);
		if (!base || target === undefined) return undefined;
		const x = key === drag.key && drag.phase === "dragging" ? drag.dx : target - base.left;
		return `translate3d(${x}px, 0, 0)`;
	};

	return (
		<div
			ref={headRef}
			className="big-modal-head"
			role="tablist"
			aria-label={t("工作台面板")}
			onPointerDown={onHeadPointerDown}
			onDoubleClick={onHeadDoubleClick}
			title={headTitle}
		>
			{renderedOrder.map((key) => {
				const isDragged = drag?.key === key;
				const className = [
					"big-tab",
					active === key ? "big-tab-on" : "",
					drag ? "big-tab-reordering" : "",
					isDragged && drag.phase === "dragging" ? "big-tab-dragging" : "",
					isDragged && drag.phase === "settling" ? "big-tab-settling" : "",
				]
					.filter(Boolean)
					.join(" ");
				return (
					<button
						type="button"
						role="tab"
						aria-selected={active === key}
						data-panel-key={key}
						key={key}
						className={className}
						style={{ transform: transformFor(key) }}
						draggable={false}
						title={`${label(key)} · ${t("拖动排序", "Drag to reorder")}`}
						onPointerDown={(event) => start(event, key)}
						onClick={() => {
							if (!suppressClick.current) onSelect(key);
						}}
					>
						<span className="big-tab-icon" aria-hidden="true">
							<PanelIcon name={key} />
						</span>
						{label(key)}
					</button>
				);
			})}
		</div>
	);
}
