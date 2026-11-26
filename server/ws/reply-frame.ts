/**
 * 回包帧的**唯一序列化处**（从 `server/index.ts` 抽出来，好让单测钉住"载荷放哪一格"）。
 *
 * 协议里 `ServerReply` 的形状是：
 *
 *   { type: "reply", id, ok: true, result?: <载荷> }
 *   { type: "reply", id, ok: false, error }
 *
 * 载荷**只在 `result` 这一格里**。这件事值得单独一个文件，因为踩过：
 * `new_chat` / `fork_session` / `suggest_title` 三个 handler 曾经把结果**扁平**地传进来
 * （`{ ok: true, conversationId }`）—— 序列化时它被当成"没有载荷"丢掉，
 * 于是客户端读 `message.result.conversationId` 永远是 undefined，
 * 「新建 / 分叉出来的会话顶到侧栏第一位」这条逻辑从来没生效过（用户 2026-11-24：「分叉功能有 bug」）。
 *
 * 所以这里**不做扁平载荷的兜底**：谁要带载荷就自己包进 `result`
 * （handler 那一层的注释里也写了）。静默兜底会把这个约定藏起来，下一个 handler 继续踩。
 */
import type { ProtocolError, ServerReply } from "../protocol.js";

export function replyFrame(
	id: string,
	result: { ok: true; result?: unknown } | { ok: false; error: ProtocolError },
): ServerReply {
	if (!result.ok) return { type: "reply", id, ok: false, error: result.error };
	return { type: "reply", id, ok: true, ...(result.result === undefined ? {} : { result: result.result }) };
}
