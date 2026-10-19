/**
 * 把「已归档的会话 id」按项目分组（纯函数，便于单测）。
 * 归档只是从主列表隐藏，会话数据仍在 pi 的存储里。
 */
import type { PiProject, SessionPrefs } from "./types.ts";

export type ArchivedGroup = { name: string; items: { id: string; title: string; time: string }[] };

export function groupArchived(projects: PiProject[], prefs: SessionPrefs): ArchivedGroup[] {
	return projects
		.map((project) => ({
			name: project.name || project.cwd,
			items: project.sessions
				.filter((session) => prefs.archived.includes(session.id))
				.map((session) => ({
					id: session.id,
					title: prefs.titles[session.id] ?? (session.title || "（无标题）"),
					time: "已归档",
				})),
		}))
		.filter((group) => group.items.length > 0);
}
