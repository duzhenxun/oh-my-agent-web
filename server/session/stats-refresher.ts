/**
 * 会话统计的刷新器（从 runtime.ts 抽出：400 行护栏）。
 * 数据源是 pi 的会话 JSONL（ADR-0021），不是内存事件累加——CLI 里开的会话也要算得对。
 */
import type { PiProject } from "../protocol.js";
import { readSessionStats } from "./session-stats.js";
import type { SessionStats } from "../protocol.js";

export function createStatsRefresher(options: {
	activeId: () => string | null;
	/** 从 opener 取会话文件路径（web 新建的会话也在这里登记过） */
	pathOf: (conversationId: string) => string | null;
	/** 兜底：pi 项目里的会话（CLI 里开的） */
	projects: () => PiProject[];
	setStats: (stats: SessionStats) => void;
	onChanged: () => void;
}): () => Promise<void> {
	return async () => {
		const id = options.activeId();
		const sessionPath =
			options
				.projects()
				.flatMap((project) => project.sessions)
				.find((session) => session.id === id)?.sessionPath ?? null;
		const stats = await readSessionStats(sessionPath);
		if (!stats) return;
		options.setStats(stats);
		options.onChanged();
	};
}
