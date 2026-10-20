/**
 * 排队消息在界面上的形状。
 *
 * 现在这个类型**以服务端为准**（快照里的 `queued`），前端不再维护自己的副本——
 * 之前的本地副本导致「× 只从界面移除、服务端照样发」的 bug。
 */
export type QueuedView = { id: string; conversationId: string; text: string };
