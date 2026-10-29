/**
 * 侧栏会话多选的两条纯逻辑（选中态本身在 `Sidebar` 里）。
 *
 * 为什么单独成文件：这两件事全是「下标与集合」的算术，却有很容易踩空的边界 ——
 * 往上连选、锚点已经被删掉、Shift 点在折叠起来看不见的会话上。抽出来就能单测，
 * 不必把侧栏整棵树渲染一遍（见 `tests/unit/session-selection.test.ts`）。
 */

/**
 * Shift 连选：在当前可见顺序 `order` 上，从锚点切到目标（**含两端**）。
 *
 * 三种退化都收成「只选目标这一条」，而不是抛错或全选：
 *   1. 没有锚点（一上来就按住 Shift）；
 *   2. 锚点已经不在可见列表里（被归档 / 删掉 / 所属项目被折叠）；
 *   3. 目标自己不在列表里。
 * 方向无所谓：从下往上 Shift 也要能选（`[start, end]` 先排序）。
 */
export function rangeSelection(order: readonly string[], anchor: string | null, target: string): string[] {
	const to = order.indexOf(target);
	const from = anchor === null ? -1 : order.indexOf(anchor);
	if (to < 0 || from < 0) return [target];
	const [start, end] = from <= to ? [from, to] : [to, from];
	return order.slice(start, end + 1);
}

/**
 * Ctrl/⌘ 加减选：已经在里面就摘掉，否则接到末尾（末尾 = 后点的，Shift 连选的锚点也取它）。
 */
export function toggleSelection(selected: readonly string[], id: string): string[] {
	return selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id];
}

/**
 * 剔掉「已经看不见了」的选中项（被删 / 被归档 / 换到归档视图 / 项目被折叠）。
 *
 * 不剔的后果很隐蔽：菜单写着「已选 5 条」，实际只剩两条还在列表里 ——
 * 那时候点「删除」就少删三条，谁都看不出来。
 * 原顺序保留（选区顺序只影响显示条数，不影响操作）。
 */
export function pruneSelection(selected: readonly string[], alive: readonly string[]): string[] {
	if (selected.length === 0) return [];
	const keep = new Set(alive);
	return selected.filter((id) => keep.has(id));
}
