/**
 * 关闭临时会话（🎭 横幅上的「关闭」）。
 *
 * 和「删除」是两件事，别混：
 *   - 删除针对**磁盘上的会话文件**（pi 的做法：改名成 `.deleted-<时间戳>`，还能从磁盘捞回来）；
 *   - 临时会话（pi 的 `--no-session`）压根没有文件，它只能被**关闭** —— 关掉就真没了。
 *
 * 所以这里一个字都不写磁盘，只做本地清场（`discard`）：内存里的会话/消息/排队项、
 * pi-opener 的「已打开」记录、引擎句柄一起放掉，侧栏那一行立刻消失。
 * 想留下内容请先「保存为正式对话」—— 那时它有了文件，才轮得到「删除」。
 */
import type { ConversationMeta, ProtocolError } from "../protocol.js";

type CloseEphemeralResult = { ok: true } | { ok: false; error: ProtocolError };

export function createCloseEphemeral(deps: {
	conversations: () => ConversationMeta[];
	isBusy: (conversationId: string) => boolean;
	/** 本地清场（runtime 的 `discardConversation`）：会话、消息、句柄全放掉 */
	discard: (conversationId: string) => void;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}): (conversationId: string) => CloseEphemeralResult {
	return (conversationId) => {
		const conversation = deps.conversations().find((item) => item.id === conversationId);
		if (!conversation) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}
		// 普通会话不许走这条路：它有文件，用户要的是「删除」（可恢复），不是「关闭」（丢内容）
		if (!conversation.ephemeral) {
			return {
				ok: false,
				error: { code: "session.not_ephemeral", message: "这不是临时对话：普通会话请用「删除」" },
			};
		}
		// 跑着回合就关 = 把一轮对话拦腰砍断（跟「保存为正式对话」同一条规矩）
		if (deps.isBusy(conversationId)) {
			return { ok: false, error: { code: "session.busy", message: "这一轮还在跑，先「停止」再关闭" } };
		}
		deps.discard(conversationId);
		deps.notice("🎭 已关闭临时对话，内存中的内容已丢弃", "info");
		deps.pushSnapshot();
		return { ok: true };
	};
}
