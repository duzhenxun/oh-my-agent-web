/**
 * 每个客户端「自己正在看哪个会话」（ADR-0033）。
 *
 * 为什么需要：`state.activeId` 是**服务端全局唯一**的一份，多标签/多设备会互相拽着切换
 * （本地点了会话 B，远程标签页下一次收到快照也变成 B）。
 *
 * 这里只存「谁在看哪」，**不复制任何会话内容**：内容的事实源仍是 `state.messages`，
 * 快照在发送时按客户端的这个值覆盖 `active` 字段即可（`buildSnapshot(state, limit, activeId)`）。
 */
export type ClientView = {
	/** 该客户端选中的会话；没有记录时返回 fallback（一般就是全局 activeId） */
	activeFor: (clientId: string | undefined, fallback: string | null) => string | null;
	setActive: (clientId: string, conversationId: string) => void;
	/** 会话被删/归档时清掉指向它的记录，避免快照里出现空文档 */
	forget: (conversationId: string) => void;
	/** 连接断开时清掉（否则这个表会随重连一直长） */
	drop: (clientId: string) => void;
	size: () => number;
};

export function createClientView(): ClientView {
	const active = new Map<string, string>();
	return {
		activeFor: (clientId, fallback) => (clientId ? (active.get(clientId) ?? fallback) : fallback),
		setActive: (clientId, conversationId) => {
			active.set(clientId, conversationId);
		},
		forget: (conversationId) => {
			for (const [clientId, id] of active) if (id === conversationId) active.delete(clientId);
		},
		drop: (clientId) => {
			active.delete(clientId);
		},
		size: () => active.size,
	};
}
