/**
 * 「自己刚发出一条消息 → 该把哪条顶到视口上方」的纯函数。
 *
 * 抽出来是因为这段判断出过两次错，而每次都要靠人肉盯界面才能发现：
 *   1. 早先按「末尾是不是 user」判断 —— 服务端在发出的瞬间就插一条 assistant 占位，
 *      于是末尾永远是 assistant，锚点从不触发；
 *   2. 后来只盯 `messages` 里的用户消息 —— 但**点建议按钮 / 快捷短语**发出去的那条，
 *      在这一轮还在跑时先落进 `queued`（排队项），`messages` 里根本没有它，
 *      于是「点一下按钮发出去」的文字就贴在输入框上方不动（用户 2026-10-30：
 *      「不像我手动回车那样发到上面去」）。
 *
 * 所以这里把三种 id 一起看：上一帧见过的会话、最后一条用户消息、最新一条排队项。
 * 返回 null = 这一帧不用顶（换会话 / 没新东西 / 只是同一条重渲染）。
 */

export type AnchorSeen = {
	/** 那一帧的会话 id：换了会话不该把画面拽到「最后一条用户消息」处（旧会话应该落在底部） */
	conversation: string | null;
	/** 最后一条用户消息的 id（插队消息不算，见调用方） */
	messageId: string | null;
	/** 最新一条排队 / 插队消息的 id（还没进 `messages`，但它就是刚点出去的那句） */
	queuedId: string | null;
};

/**
 * @param seen 上一帧记住的三样东西
 * @param current 这一帧的三样东西
 * @returns `seen` 要写回的新值，以及要顶到上方的那条消息 id（null = 不动）
 */
export function nextAnchorTarget(
	seen: AnchorSeen,
	current: AnchorSeen,
): { seen: AnchorSeen; target: string | null } {
	// 刚换会话（含第一次挂载）：只记下来，不锚 —— 打开旧会话应该落在最新进度
	if (seen.conversation !== current.conversation) return { seen: current, target: null };
	// 真实消息优先：排队项解除的那一刻两者同时变化，要盯真正进了聊天区的那条
	if (current.messageId !== null && seen.messageId !== current.messageId) return { seen: current, target: current.messageId };
	if (current.queuedId !== null && seen.queuedId !== current.queuedId) return { seen: current, target: current.queuedId };
	return { seen: current, target: null };
}
