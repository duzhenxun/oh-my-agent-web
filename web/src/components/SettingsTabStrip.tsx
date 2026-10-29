import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import {
	dropSettingsIndex,
	moveSettingsTab,
	previewSettingsOrder,
	previewSlotLefts,
	type SettingsTabId,
	type TabSlot,
} from "../settings-tabs.ts";

/** 手要移动这么多像素才算「在拖」，否则仍当成一次点击 */
const DRAG_SLOP = 5;
/** 松手后浏览器还会补一次 click：这么久之内不许它切页，免得拖完顺手跳走 */
const CLICK_GUARD_MS = 350;
const SORTING_CLASS = "is-tab-sort-dragging";

type Pending = { pointerId: number; id: SettingsTabId; startX: number; startY: number };

type DragState = {
	id: SettingsTabId;
	/** 拖动开始时它排第几 —— 之后所有几何都按这个下标的槽位算 */
	fromIndex: number;
	slots: TabSlot[];
	/** 松手后会落到第几个位置（预览顺序里的下标） */
	toIndex: number;
	/** 相对起点的横向位移，拖动项靠它跟手 */
	dx: number;
};

/**
 * 设置面板顶部那排标签：可以**横向拖动排序**，顺序的第一项就是下次打开设置时默认显示的页
 * （顺序的存取在 `../settings-tabs.ts`，这里只负责手势与画面）。
 *
 * 为什么自己写 Pointer Events 而不用 HTML5 拖拽：手机上键盘之外的唯一输入就是手指，
 * `drag*` 事件既不跟手也拿不到位移；Pointer Events 一套代码桌面 / 触屏都行，
 * 还能用「横向 = 排序、竖向 = 交给页面滚动」把滚动手势让出去（CSS 里 `touch-action: pan-y`）。
 *
 * 拖动期间真实 DOM 顺序**不动**：跟手的那个跟着指针走，其它标签按「拖到这儿会变成什么顺序」
 * 用 transform 让位（`previewSlotLefts`）；松手时才把真顺序换成预览顺序并同时撤掉 transform，
 * 所以既不会「松手跳一下」，也不用给每个标签做位移动画。
 *
 * 键盘也能改：`←/→` 切页（和普通标签栏一样），`Alt + ←/→` 把当前页往左/右挪一位并存下来。
 */
export function SettingsTabStrip({
	order,
	active,
	label,
	onSelect,
	onOrderChange,
}: {
	order: SettingsTabId[];
	active: SettingsTabId;
	label: (id: SettingsTabId) => ReactNode;
	onSelect: (id: SettingsTabId) => void;
	/** 顺序变了（拖完 / 键盘挪动）：调用方负责存 —— 通常就是 `useSettingsTabOrder` 的 setter */
	onOrderChange: (next: SettingsTabId[]) => void;
}) {
	const stripRef = useRef<HTMLDivElement>(null);
	const pending = useRef<Pending | null>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const dragRef = useRef<DragState | null>(null);
	/** 这次 pointerup 之后紧跟的 click 不算点击 */
	const swallowClick = useRef(false);
	const swallowTimer = useRef<number | null>(null);

	const applyDrag = (next: DragState | null) => {
		dragRef.current = next;
		setDrag(next);
		if (next) document.documentElement.classList.add(SORTING_CLASS);
		else document.documentElement.classList.remove(SORTING_CLASS);
	};

	useEffect(
		() => () => {
			document.documentElement.classList.remove(SORTING_CLASS);
			if (swallowTimer.current !== null) window.clearTimeout(swallowTimer.current);
		},
		[],
	);

	/** 量一遍当前顺序下每个标签的槽位；量不全（还没渲染 / 被隐藏）就返回 null，宁可不拖 */
	const measureSlots = (): TabSlot[] | null => {
		const strip = stripRef.current;
		if (!strip) return null;
		const slots: TabSlot[] = [];
		for (const id of order) {
			const node = strip.querySelector<HTMLElement>(`[data-settings-tab="${id}"]`);
			if (!node) return null;
			const rect = node.getBoundingClientRect();
			slots.push({ left: rect.left, width: rect.width });
		}
		return slots;
	};

	const releaseCapture = (node: HTMLElement | null, pointerId: number) => {
		try {
			if (node?.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
		} catch {
			// 指针可能已经先被浏览器收走，忽略即可
		}
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: SettingsTabId) => {
		// 只认左键 / 单指：右键、中键留给系统菜单
		if (event.button !== 0 || dragRef.current) return;
		pending.current = { pointerId: event.pointerId, id, startX: event.clientX, startY: event.clientY };
		// 抓住指针：拖到标签外面（甚至拖出面板）也还能收到 move/up
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// 个别环境不支持 capture，退化成只在标签内拖动
		}
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const start = pending.current;
		if (!start || start.pointerId !== event.pointerId) return;
		const dx = event.clientX - start.startX;
		const dy = event.clientY - start.startY;
		const current = dragRef.current;

		if (!current) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return;
			// 明显是在上下滚页面：让给页面，不再插手这次手势
			if (Math.abs(dy) > Math.abs(dx)) {
				pending.current = null;
				releaseCapture(event.currentTarget, event.pointerId);
				return;
			}
			const slots = measureSlots();
			const fromIndex = order.indexOf(start.id);
			if (!slots || fromIndex < 0) {
				pending.current = null;
				return;
			}
			event.preventDefault();
			applyDrag({ id: start.id, fromIndex, slots, toIndex: fromIndex, dx });
			return;
		}

		event.preventDefault();
		const slot = current.slots[current.fromIndex];
		if (!slot) return;
		// 用拖动项自己的中心判断落点：拿指针位置的话，从标签右半边按下会立刻跳到下一个槽
		const center = slot.left + slot.width / 2 + dx;
		applyDrag({ ...current, dx, toIndex: dropSettingsIndex(order, current.id, center, current.slots) });
	};

	const finish = (commit: boolean) => {
		const current = dragRef.current;
		pending.current = null;
		if (!current) return;
		applyDrag(null);
		// 拖完浏览器补的那次 click 不许当成「点了某个标签」
		swallowClick.current = true;
		if (swallowTimer.current !== null) window.clearTimeout(swallowTimer.current);
		swallowTimer.current = window.setTimeout(() => {
			swallowClick.current = false;
		}, CLICK_GUARD_MS);
		if (commit) onOrderChange(previewSettingsOrder(order, current.id, current.toIndex));
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (pending.current?.pointerId !== event.pointerId) return;
		releaseCapture(event.currentTarget, event.pointerId);
		finish(true);
	};

	const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (pending.current?.pointerId !== event.pointerId) return;
		releaseCapture(event.currentTarget, event.pointerId);
		finish(false); // 被系统手势 / 来电打断：顺序回原样
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		const node = (event.target as HTMLElement).closest<HTMLElement>("[data-settings-tab]");
		const id = node?.dataset.settingsTab as SettingsTabId | undefined;
		const index = id ? order.indexOf(id) : -1;
		if (index < 0) return;
		event.preventDefault();

		if (event.altKey) {
			// Alt + ←/→：挪位置（到头就停，不循环，免得一按就跑到另一头）
			const toIndex = index + step;
			if (toIndex < 0 || toIndex > order.length - 1) return;
			onOrderChange(moveSettingsTab(order, index, toIndex));
			return;
		}

		// 普通 ←/→：切到相邻那页，并把焦点带过去（标签栏的常规操作）
		const target = order[(index + step + order.length) % order.length];
		if (!target) return;
		onSelect(target);
		stripRef.current?.querySelector<HTMLElement>(`[data-settings-tab="${target}"]`)?.focus();
	};

	const preview = drag ? previewSettingsOrder(order, drag.id, drag.toIndex) : order;
	const slotLefts = drag ? previewSlotLefts(order, preview, drag.slots) : null;

	/** 拖动中每个标签要去的位置：自己的槽位左缘 → 预览槽位左缘 */
	const shiftFor = (id: SettingsTabId): number => {
		if (!drag || !slotLefts) return 0;
		if (id === drag.id) return drag.dx;
		const home = drag.slots[order.indexOf(id)]?.left;
		const target = slotLefts.get(id);
		if (home === undefined || target === undefined) return 0;
		return target - home;
	};

	return (
		<div ref={stripRef} className="settings-tabs" role="tablist" onKeyDown={onKeyDown}>
			{/* 顺序始终用真实的 order 渲染：让位靠 transform，松手才换 DOM 顺序 */}
			{order.map((id) => {
				const dragging = drag?.id === id;
				const className = [
					"settings-tab",
					active === id ? "settings-tab-on" : "",
					drag ? "settings-tab-reordering" : "",
					dragging ? "settings-tab-dragging" : "",
				]
					.filter(Boolean)
					.join(" ");
				const shift = shiftFor(id);
				return (
					<button
						type="button"
						role="tab"
						key={id}
						data-settings-tab={id}
						aria-selected={active === id}
						tabIndex={active === id ? 0 : -1}
						className={className}
						draggable={false}
						style={
							drag
								? { transform: `translate3d(${shift}px, 0, 0)`, transition: dragging ? "none" : undefined }
								: undefined
						}
						onPointerDown={(event) => onPointerDown(event, id)}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerCancel}
						onClick={() => {
							if (!swallowClick.current) onSelect(id);
						}}
					>
						{label(id)}
					</button>
				);
			})}
		</div>
	);
}
