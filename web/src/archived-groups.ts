/**
 * 把「已归档的会话 id」按项目分组（纯函数）。
 * 归档只是从主列表隐藏，会话数据仍在 pi 的存储里。
 */
import type { PiProject, SessionPrefs } from "./types.ts";

type ArchivedGroup = { name: string; items: { id: string; title: string; time: string }[] };

export function groupArchived(projects: PiProject[], prefs: SessionPrefs): ArchivedGroup[] {
	return projects
		.map((project) => ({
			name: project.name || project.cwd,
			items: project.sessions
				.filter((session) => prefs.archived.includes(session.id))
				.map((session) => ({
					id: session.id,
					title: session.title || "（无标题）",
					time: "已归档",
				})),
		}))
		.filter((group) => group.items.length > 0);
}

/** 项目默认展开规则：显式记录优先；否则第一个项目或含当前会话的项目展开 */
export function isProjectOpen(
	project: { cwd: string; sessions: { id: string }[] },
	index: number,
	openMap: Record<string, boolean>,
	activeId: string | null,
): boolean {
	return openMap[project.cwd] ?? (index === 0 || project.sessions.some((session) => session.id === activeId));
}
