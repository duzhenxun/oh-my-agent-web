/**
 * 项目排序（ADR-0028 §3）：pinned 段在上 → 其余按显式 order → 新项目插到最上面。
 *
 * 「新项目」= 既不在 order 也不在 pinned 的项目（刚建的 / pi CLI 建的），
 * 按「最新会话创建时间」倒序插在**未置顶段的最上面**——这是确定性规则，
 * 不需要"用户是否拖过"这种隐式状态。
 */
import type { ProjectPrefs } from "./types.ts";

export type SortableProject = { cwd: string; sessions: { startedAt: number }[] };

export function newestSessionAt(project: SortableProject): number {
	return project.sessions.reduce((max, session) => Math.max(max, session.startedAt), 0);
}

export function sortProjects<T extends SortableProject>(projects: T[], prefs: ProjectPrefs): T[] {
	const pinnedOrder = new Map(prefs.pinned.map((cwd, index) => [cwd, index]));
	const explicitOrder = new Map(prefs.order.map((cwd, index) => [cwd, index]));

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

/** 纯函数：把某个项目移动到目标索引（用于「上移 / 下移」与拖动） */
export function moveProject(order: string[], projects: SortableProject[], from: string, toIndex: number): string[] {
	const list = projects.map((project) => project.cwd).filter((cwd) => cwd !== from);
	const clamped = Math.max(0, Math.min(toIndex, list.length));
	list.splice(clamped, 0, from);
	void order;
	return list;
}
