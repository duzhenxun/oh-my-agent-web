/**
 * 每个客户端「自己正在看哪个会话」（ADR-0033）。
 *
 * 纪律：**每个浏览器只认自己那一份**。客户端有记录就看它自己的；
 * 没记录就是「空」（界面回到欢迎页），**绝不回落到 `state.activeId`** ——
 * 那份全局值只是服务端给 stats / models / 文件树用的「最近操作过的会话」，
 * 一旦拿它当别人的默认视图，多标签 / 多设备就会互相拽着跳（真实症状：
 * 电脑上切会话，手机上也跟着换）。
 *
 * 这里只存「谁在看哪」和「谁收过哪一版会话清单」，**不复制任何会话内容**：内容的事实源仍是
 * `state.messages`，快照在发送时按客户端的这个值覆盖 `active` 字段即可
 * （`buildSnapshot(state, limit, activeId)`）。
 */

/** 会话清单最多隔这么久重发一次（防丢帧：中间被合并 / 丢掉的帧自己长回来） */
export const PROJECTS_RESEND_MS = 30_000;

export type ClientView = {
	/**
	 * 该客户端选中的会话。
	 * - 给了 clientId：只用它自己那份记录；**没有记录就是 null（空视图）**，不看 fallback；
	 * - 没给 clientId（服务端内部推送 / 老客户端）：才用 fallback（全局 activeId）。
	 */
	activeFor: (clientId: string | undefined, fallback: string | null) => string | null;
	setActive: (clientId: string, conversationId: string) => void;
	/** 会话被删/归档时清掉指向它的记录，避免快照里出现空文档 */
	forget: (conversationId: string) => void;
	/**
	 * 连接断开时收尾 —— **只清临时记账，保留视图**。
	 *
	 * 为什么不能把视图一起删：SSE 会不停重连（代理掐连接、手机切后台、wifi 抖动）。
	 * 一删，这个客户端下一帧就「不认识自己」→ 回落成全局 activeId → 手机跟着电脑跳会话
	 * （真实症状：电脑上切会话，手机上也跟着换）。
	 */
	drop: (clientId: string) => void;
	/** 切引擎时全部清掉：新引擎没有这些会话，旧指向必须作废 */
	reset: () => void;
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

/** 视图表上限：断线不再删视图，就得防止无限增长（正常人也就几个标签页 / 设备） */
export const MAX_CLIENT_VIEWS = 200;

export function createClientView(): ClientView {
	/** clientId → 它自己在看的会话（null = 明确「什么都不看」，比如刚打开的新标签页） */
	const active = new Map<string, string | null>();
	/** 能接受「省略会话清单」的客户端 */
	const slim = new Set<string>();
	/** 这个客户端上次收到会话清单是哪个版本、什么时候 */
	const projectsSent = new Map<string, { version: number; at: number }>();
	/** 记一条视图：重插到末尾当「最近使用」，超上限就把最久没动的丢掉 */
	const remember = (clientId: string, conversationId: string | null) => {
		active.delete(clientId);
		active.set(clientId, conversationId);
		if (active.size > MAX_CLIENT_VIEWS) {
			const oldest = active.keys().next().value;
			if (oldest !== undefined) active.delete(oldest);
		}
	};

	return {
		activeFor: (clientId, fallback) => {
			// 服务端内部（没有 clientId）：用全局那份
			if (!clientId) return fallback;
			// 认识这个客户端：**只认它自己的**（null 也照原样返回 = 空视图）
			if (active.has(clientId)) return active.get(clientId) ?? null;
			// 第一次见：记成「空」。之后它自己点会话 / 发消息会把记录填上
			remember(clientId, null);
			return null;
		},
		setActive: (clientId, conversationId) => {
			remember(clientId, conversationId);
		},
		forget: (conversationId) => {
			for (const [clientId, id] of active) if (id === conversationId) active.delete(clientId);
		},
		drop: (clientId) => {
			// 视图（active）**故意保留**：重连后还要认自己看过哪个会话，见类型注释
			slim.delete(clientId);
			projectsSent.delete(clientId);
		},
		reset: () => {
			active.clear();
			projectsSent.clear();
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
