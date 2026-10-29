/**
 * 会话统计的刷新器（从 runtime.ts 抽出：400 行护栏）。
 * 数据源是 pi 的会话 JSONL（ADR-0021），不是内存事件累加——CLI 里开的会话也要算得对。
 *
 * 这一版直接吃 `ServerState`：切引擎时会被清空重算，所以不再由调用方拼装 setter。
 */
import type { PiProject, SessionStats } from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import { emptyStats, readSessionStats } from "./session-stats.js";

export function createStatsRefresher(options: {
	state: ServerState;
	/** 从 opener 取会话文件路径（web 新建的会话也在这里登记过） */
	pathOf: (conversationId: string) => string | null;
	/** 引擎自带的统计（dsh 从会话日志算）；返回 null 时退回 pi 的文件解析 */
	statsOf?: (conversationId: string) => Promise<SessionStats | null>;
	onChanged: () => void;
}): (conversationId?: string) => Promise<void> {
	/** 写回：**按读的时候那个会话写**，不能在回来时再用 state.activeId（期间可能已经切走了） */
	const apply = (stats: SessionStats, conversationId: string): void => {
		const { state } = options;
		// 会话级缓存：别的标签页看自己的会话时不会读到别人那份
		state.statsByConversation[conversationId] = stats;
		// 面板只显示「当前会话」的数字：切走了就别把上一条的统计糊到新会话上
		if (state.activeId === conversationId) state.sessionStats = stats;
	};
	/**
	 * 读不到统计（新会话还没落盘 / 刚建空文件 / 读失败）：把面板**清零**。
	 * 以前是 `return` 走人 —— 于是上一个会话的 token 数就赖在那儿，新建的会话看着「有记录」。
	 */
	const clear = (conversationId: string): void => {
		const { state } = options;
		const zero = emptyStats();
		state.statsByConversation[conversationId] = zero;
		if (state.activeId === conversationId) state.sessionStats = { ...zero };
	};

	return async (conversationId?: string) => {
		const { state } = options;
		/**
		 * 要刷**哪个会话**的统计：默认当前活跃会话（切会话后刷那一份），
		 * 但回合收尾时必须传**回合自己的**会话 id —— 并行回合下 activeId 指的可能是别人。
		 * 以前这里硬取 activeId，于是 A 会话跑完会把 A 的 token 数写到 B 的面板上。
		 */
		const id = conversationId ?? state.activeId;
		if (!id) return;
		// 引擎自带统计优先（dsh）：它知道自己日志里的四桶用量
		const fromEngine = options.statsOf ? await options.statsOf(id).catch(() => null) : null;
		if (fromEngine) {
			apply(fromEngine, id);
			options.onChanged();
			return;
		}
		// 会话文件路径：opener 登记过的直接用（web 新建的会话也在那儿），没有再扫清单
		const sessionPath =
			options.pathOf(id) ??
			state.piProjects.flatMap((project: PiProject) => project.sessions).find((session) => session.id === id)
				?.sessionPath ??
			null;
		const stats = await readSessionStats(sessionPath);
		// 新会话（文件还没写 / 只有 header）本来就是 0，别把上一个会话的数字留在屏幕上
		if (!stats) {
			clear(id);
			options.onChanged();
			return;
		}
		apply(stats, id);
		options.onChanged();
	};
}
