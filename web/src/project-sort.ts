/**
 * 项目排序（ADR-0028 §3）：pinned 段在上 → 其余按显式 order → 新项目插到最上面。
 *
 * 「新项目」= 既不在 order 也不在 pinned 的项目（刚建的 / pi CLI 建的），
 * 按「最新会话创建时间」倒序插在**未置顶段的最上面**——这是确定性规则，
 * 不需要"用户是否拖过"这种隐式状态。
 */
import type { ProjectPrefs } from "./types.ts";

type SortableProject = { cwd: string; sessions: { startedAt: number }[] };

function newestSessionAt(project: SortableProject): number {
	return project.sessions.reduce((max, session) => Math.max(max, session.startedAt), 0);
}

/** cwd → 首次出现的索引：与服务端归一化（去重保留首次）对齐，脏数据不改变相对顺序 */
function firstIndex(list: string[]): Map<string, number> {
	const map = new Map<string, number>();
	list.forEach((cwd, index) => {
		if (!map.has(cwd)) map.set(cwd, index);
	});
	return map;
}

export function sortProjects<T extends SortableProject>(projects: T[], prefs: ProjectPrefs): T[] {
	const pinnedOrder = firstIndex(prefs.pinned);
	const explicitOrder = firstIndex(prefs.order);

	const pinned = projects
		.filter((project) => pinnedOrder.has(project.cwd))
		.sort((a, b) => (pinnedOrder.get(a.cwd) ?? 0) - (pinnedOrder.get(b.cwd) ?? 0));

	const rest = projects.filter((project) => !pinnedOrder.has(project.cwd));
	const known = rest
		.filter((project) => explicitOrder.has(project.cwd))
		.sort((a, b) => (explicitOrder.get(a.cwd) ?? 0) - (explicitOrder.get(b.cwd) ?? 0));
	// 新项目：插在未置顶段的最上面
	const fresh = rest
		.filter((project) => !explicitOrder.has(project.cwd))
		.sort((a, b) => newestSessionAt(b) - newestSessionAt(a) || a.cwd.localeCompare(b.cwd));

	return [...pinned, ...fresh, ...known];
}

/**
 * 拖动改项目顺序（侧栏那个手势背后的纯函数）：把 `from` 插到 `target` 的**前 / 后**，
 * 再按「谁在置顶段」把结果拆回 `pinned` / `order` 两段。
 *
 * 输入 `visible` 是**当前看到的顺序**（`sortProjects` 之后那一整列 cwd）—— 用它当唯一真相，
 * 而不是分别去动 `order` / `pinned` 两个数组：前者跟眼睛看到的一致，后者一不小心就得出
 * 「拖完一处、另一处顺序莫名变了」。
 *
 * 跨段拖动按**目标所在段**算归属：拖到置顶段里就顺便置顶，拖回下面段就取消置顶。
 * 不这么做的话，松手那一下 `sortProjects` 会把它排回自己那一段的原位，看着像「拖了没反应」。
 *
 * 返回 null = 这次拖动不该改动任何东西（拖到自己身上 / 目标不在列表里）。
 */
export function reorderProjects(input: {
	visible: string[];
	pinned: string[];
	from: string;
	target: string;
	after: boolean;
}): { pinned: string[]; order: string[] } | null {
	const { visible, pinned, from, target, after } = input;
	if (from === target || !visible.includes(from)) return null;
	const nextPinned = new Set(pinned);
	if (pinned.includes(target)) nextPinned.add(from);
	else nextPinned.delete(from);
	const next = visible.filter((cwd) => cwd !== from);
	// 目标索引要在「摘掉被拖项之后」的列表里量：否则往前拖时下标会偏一格
	const at = next.indexOf(target);
	if (at < 0) return null;
	next.splice(at + (after ? 1 : 0), 0, from);
	return {
		pinned: next.filter((cwd) => nextPinned.has(cwd)),
		order: next.filter((cwd) => !nextPinned.has(cwd)),
	};
}
