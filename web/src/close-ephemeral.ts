/**
 * 关闭临时会话（临时会话提示条上的「关闭」）：二次确认 → 让服务端把内存里那条会话放掉。
 *
 * 为什么这里要单独确认一次，而「删除」也是确认：这两个动作都**不可逆**，
 * 但代价不一样 —— 删除只是改文件名（能从磁盘捞回来），关闭是直接把内容丢掉，没有文件。
 * 所以提示里直接写明「想留下请先保存为正式对话」，别让人点错了才发现找不回来。
 */
import { forgetCachedMessages } from "./session-cache.ts";
import { forgetDraft } from "./store.ts";
import { closeEphemeral } from "./ws.ts";

export function closeEphemeralChat(conversationId: string, title: string): void {
	const ok = window.confirm(
		`关闭临时对话「${title || "未命名会话"}」？\n\n` +
			"它只活在内存里（没有会话文件），关闭后内容直接丢弃，无法恢复。\n" +
			"想留下去历史里找，请先点「保存为正式对话」。",
	);
	if (!ok) return;
	void forgetCachedMessages(conversationId); // 本地缓存的正文也一并删掉
	// 这条会话彻底没了，它那一格草稿也丢掉（不丢的话也再没有人能把它写回输入框）
	forgetDraft(conversationId);
	closeEphemeral(conversationId);
}
