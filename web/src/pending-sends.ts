/**
 * 「排队 / 插队」待发消息的本地记录（只用于界面展示）。
 *
 * 说明清楚一条边界：服务端的队列只在内部，逐条内容不下发；
 * 这里记的是**用户发过什么**，所以 ✕ 只是从界面移除，不代表服务端取消了那条。
 */
export type PendingSend = { id: number; mode: "steer" | "queue"; text: string };

/** 插队（steer）排在前面，其它按发送顺序 —— 与"先插队、后排队"的处理顺序一致 */
export function sortPendingSends(items: PendingSend[]): PendingSend[] {
	return [...items].sort((a, b) => {
		if (a.mode !== b.mode) return a.mode === "steer" ? -1 : 1;
		return a.id - b.id;
	});
}
