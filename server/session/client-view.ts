/**
 * 每个客户端「自己正在看哪个会话」（ADR-0033）。
 *
 * 为什么需要：`state.activeId` 是**服务端全局唯一**的一份，多标签 / 多设备会互相拽着切换
 * （本地点了会话 B，远程标签页下一次收到快照也变成 B）。
 *
 * 这里只存「谁在看哪」和「谁收过哪一版会话清单」，**不复制任何会话内容**：内容的事实源仍是
 * `state.messages`，快照在发送时按客户端的这个值覆盖 `active` 字段即可
 * （`buildSnapshot(state, limit, activeId)`）。
 */

/** 会话清单最多隔这么久重发一次（防丢帧：中间被合并 / 丢掉的帧自己长回来） */
export const PROJECTS_RESEND_MS = 30_000;

export type ClientView = {
	/** 该客户端选中的会话；没有记录时返回 fallback（一般就是全局 activeId） */
	activeFor: (clientId: string | undefined, fallback: string | null) => string | null;
	setActive: (clientId: string, conversationId: string) => void;
	/** 会话被删/归档时清掉指向它的记录，避免快照里出现空文档 */
	forget: (conversationId: string) => void;
	/** 连接断开时清掉（否则这个表会随重连一直长） */
	drop: (clientId: string) => void;
	size: () => number;
	/** 这个客户端「受得了省略会话清单」（SSE 上带了 slim=1）—— 老客户端不标记，照旧每帧都带 */
	setSlim: (clientId: string, slim: boolean) => void;
	/**
	 * 这一帧要不要带 pi 会话清单：只有「受得了 slim」的客户端才可能省；
	 * 省的条件是：这个客户端还没收到过、清单版本变了、或者距上次发送已经过了
	 * `PROJECTS_RESEND_MS`（丢了一帧也能自己长回来）。
	 * 调用即记账（同一帧只调一次）。
	 */
	needsProjects: (clientId: string | undefined, version: number, now: number) => boolean;
};

export function createClientView(): ClientView {
	const active = new Map<string, string>();
	/** 能接受「省略会话清单」的客户端 */
	const slim = new Set<string>();
	/** 这个客户端上次收到会话清单是哪个版本、什么时候 */
	const projectsSent = new Map<string, { version: number; at: number }>();
	return {
		activeFor: (clientId, fallback) => {
			if (!clientId) return fallback;
			const own = active.get(clientId);
			// 定型过就认它：之后全局 activeId 被别人改也不影响这个客户端（串台的真正来源）。
			// 例外是「定型在空」——那是连上来时一个会话都还没有，遇到第一个会话要能跟上，
			// 否则新建 / 首发消息建出来的会话，这个客户端永远看不到（界面像「没跳过去」）。
			if (own !== undefined && own !== "") return own;
			if (own === "" && fallback) {
				active.set(clientId, fallback);
				return fallback;
			}
			active.set(clientId, fallback ?? "");
			return fallback;
		},
		setActive: (clientId, conversationId) => {
			active.set(clientId, conversationId);
		},
		forget: (conversationId) => {
			for (const [clientId, id] of active) if (id === conversationId) active.delete(clientId);
		},
		drop: (clientId) => {
			active.delete(clientId);
			slim.delete(clientId);
			projectsSent.delete(clientId);
		},
		size: () => [...active.values()].filter((id) => id !== "").length,
		setSlim: (clientId, next) => {
			if (next) slim.add(clientId);
			else slim.delete(clientId);
		},
		needsProjects: (clientId, version, now) => {
			// 不认识的客户端（全局快照 / WS）一律带：宁可多发，不能让人家列表变空
			if (!clientId || !slim.has(clientId)) return true;
			const previous = projectsSent.get(clientId);
			const shouldSend = !previous || previous.version !== version || now - previous.at >= PROJECTS_RESEND_MS;
			if (shouldSend) projectsSent.set(clientId, { version, at: now });
			return shouldSend;
		},
	};
}
