/** 弹窗 Tab 拖拽里的纯计算，和 React / DOM 分开，方便覆盖不同宽度与边界。
 *
 * 2026-10-29 抽成泛型：设置面板那排标签也复用同一套排序（见 `SortableTabs.tsx`）。 */

export type TabBox = { left: number; width: number };
/** 旧名（`PanelTabBox`）保留：panel-tab-dnd 这个名字是历史文件名 */
export type PanelTabBox = TabBox;
type TabBoxes<T extends string> = ReadonlyMap<T, TabBox>;

/**
 * 用拖动项的中心和「原始位置」的兄弟中心比较。
 * 不以正在让位的兄弟位置为阈值，否则越过半个 Tab 后阈值也跟着跑，会在边界来回抖动。
 */
export function panelTabTargetIndex<T extends string>(
	baseOrder: readonly T[],
	dragged: T,
	draggedCenter: number,
	boxes: TabBoxes<T>,
): number {
	const siblings = baseOrder.filter((key) => key !== dragged);
	let index = siblings.length;
	for (let i = 0; i < siblings.length; i += 1) {
		const box = boxes.get(siblings[i] as T);
		if (!box) continue;
		if (draggedCenter < box.left + box.width / 2) {
			index = i;
			break;
		}
	}
	return index;
}

/**
 *  DOM 在拖动期间保持原顺序，兄弟只用 transform 让位。
 * 这里按预览顺序重算每个 Tab 的目标左缘；松手后真实 DOM 换成同一顺序，位置严丝合缝。
 */
export function layoutPanelTabs<T extends string>(
	order: readonly T[],
	boxes: TabBoxes<T>,
	gap: number,
): Map<T, number> {
	const result = new Map<T, number>();
	// 起点永远是最左侧的原始槽位，不能取预览数组第一项的原位置（它可能正是要被让开的项）。
	let left = Number.POSITIVE_INFINITY;
	for (const key of order) {
		const box = boxes.get(key);
		if (box) left = Math.min(left, box.left);
	}
	if (!Number.isFinite(left)) return result;
	for (const key of order) {
		const box = boxes.get(key);
		if (!box) continue;
		result.set(key, left);
		left += box.width + gap;
	}
	return result;
}
