import type { QueuedMode } from "./types.ts";

/**
 * 待发消息（排队 / 插队）在界面上的形状。
 *
 * 现在这个类型**以服务端为准**（快照里的 `queued`），前端不再维护自己的副本——
 * 之前的本地副本导致「× 只从界面移除、服务端照样发」的 bug。
 *
 * 两种语义共用同一条待发行（形状、按钮都一样），只有标签不同：
 *   - `queue`：等这一轮结束再发；
 *   - `steer`：插队，先挂在服务端，到当前回合的 step 边界才注入 —— **注入前 × 是真取消**。
 */
export type QueuedView = {
	id: string;
	conversationId: string;
	text: string;
	/** queue = 排队；steer = 插队（还没插进去，所以也能撤回 / 取消） */
	mode: QueuedMode;
};
