import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { layoutPanelTabs, panelTabTargetIndex, type TabBox } from "../panel-tab-dnd.ts";
import { moveSettingsTab, sameTabOrder, type SettingsTabId } from "../settings-tab-order.ts";

const DRAG_THRESHOLD = 5;
const SETTLE_MS = 180;
const DRAG_CLASS = "is-tab-sort-dragging";

type DragState<T extends string> = {
	key: T;
	baseOrder: T[];
	previewOrder: T[];
	boxes: Map<T, TabBox>;
	gap: number;
	dx: number;
	phase: "dragging" | "settling";
};

/**
 * 一排可以**拖动排序**的标签（设置面板顶部那排用这个）。
 *
 * 用户 2026-10-29：「上面这些可以手动调位置。哪个在最左边第一个，到时点开设置时就显示它」——
 * 排序本身由外部存（`settings-tab-order.ts`），这个组件只管拖：拖谁、放哪、通知新顺序。
 *
 * 拖动期间的 DOM **不换位**：拖动项跟手、其余标签用 transform 让位（纯计算在
 * `panel-tab-dnd.ts`，和弹窗顶部那排 Tab 共用同一套）。松手先滑入目标槽位再撤掉 transform，
 * 此时真实顺序已经是预览顺序，不会「松手跳一下」。
 *
 * 为什么不用原生 HTML5 拖拽：手机上没有 drag 事件之外的手势、也拿不到跟手的位移；
 * Pointer Events 一套代码桌面 / 触屏都对，而且能明确区分「横向拖 = 排序 / 竖向拖 = 滚动」。
 */
export function SortableSettingsTabs({
	order,
	active,
	label,
	onSelect,
	onOrderChange,
}: {
	order: SettingsTabId[];
	active: SettingsTabId;
	label: (id: SettingsTabId) => ReactNode;
	/** 排序完成后：新顺序的第一项要被当成「默认打开的那一页」，由调用方处理 */
	onSelect: (id: SettingsTabId) => void;
	onOrderChange: (next: SettingsTabId[]) => void;
}) {
	const headRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState<SettingsTabId> | null>(null);
	const dragRef = useRef<DragState<SettingsTabId> | null>(null);
	const cancelSession = useRef<(() => void) | null>(null);
	const settleTimer = useRef<number | null>(null);
	const suppressClick = useRef(false);
	const suppressTimer = useRef<number | null>(null);

	const updateDrag = (next: DragState<SettingsTabId> | null) => {
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

	const start = (event: ReactPointerEvent<HTMLButtonElement>, key: SettingsTabId) => {
		if (event.button !== 0 || dragRef.current) return;

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

		const notify = (next: SettingsTabId[]) => {
			if (sameTabOrder(notifiedOrder, next)) return;
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
			const previewOrder = moveSettingsTab(baseOrder, key, target);
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

			// 拖完松手通常会合成一次 click；这次 click 不能再切走当前页
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
				// 触屏上的竖向手势留给页面滚动；明确的横向手势才进入排序
				if (Math.abs(dy) > Math.abs(dx)) {
					cleanup();
					return;
				}
				const head = headRef.current;
				if (!head) return;
				const boxes = new Map<SettingsTabId, TabBox>();
				for (const id of baseOrder) {
					const node = head.querySelector<HTMLElement>(`[data-settings-tab="${id}"]`);
					if (!node) continue;
					const rect = node.getBoundingClientRect();
					boxes.set(id, { left: rect.left, width: rect.width });
				}
				if (boxes.size !== baseOrder.length) {
					cleanup();
					return;
				}
				started = true;
				try {
					button.setPointerCapture(pointerId);
				} catch {
					// document 级监听已经能兜住；不支持 pointer capture 也不影响排序
				}
				document.documentElement.classList.add(DRAG_CLASS);
				const gap = Number.parseFloat(window.getComputedStyle(head).columnGap) || 0;
				updateDrag({ key, baseOrder, previewOrder: baseOrder, boxes, gap, dx, phase: "dragging" });
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
				// 指针可能已经被浏览器收回
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
	const transformFor = (key: SettingsTabId): string | undefined => {
		if (!drag || !targetLayout) return undefined;
		const base = drag.boxes.get(key);
		const target = targetLayout.get(key);
		if (!base || target === undefined) return undefined;
		const x = key === drag.key && drag.phase === "dragging" ? drag.dx : target - base.left;
		return `translate3d(${x}px, 0, 0)`;
	};

	return (
		<div ref={headRef} className="settings-tabs" role="tablist">
			{renderedOrder.map((id) => {
				const isDragged = drag?.key === id;
				const className = [
					"settings-tab",
					active === id ? "settings-tab-on" : "",
					drag ? "settings-tab-reordering" : "",
					isDragged && drag.phase === "dragging" ? "settings-tab-dragging" : "",
					isDragged && drag.phase === "settling" ? "settings-tab-settling" : "",
				]
					.filter(Boolean)
					.join(" ");
				return (
					<button
						type="button"
						role="tab"
						key={id}
						data-settings-tab={id}
						aria-selected={active === id}
						className={className}
						style={{ transform: transformFor(id) }}
						draggable={false}
						onPointerDown={(event) => start(event, id)}
						onClick={() => {
							if (!suppressClick.current) onSelect(id);
						}}
					>
						{label(id)}
					</button>
				);
			})}
		</div>
	);
}
