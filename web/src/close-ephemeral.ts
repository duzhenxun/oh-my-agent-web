/**
 * 关闭临时会话（临时会话提示条上的「关闭」）的**执行**部分：让服务端把内存里那条会话放掉。
 *
 * 二次确认不在这里做，而在 `components/CloseEphemeralDialog.tsx`（自绘弹窗）：
 * 不用 `window.confirm`，因为浏览器能整页屏蔽原生对话框（见 use-armed.ts 顶部注释）。
 *
 * 为什么要单独确认一次，而「删除」也是确认：这两个动作都**不可逆**，
 * 但代价不一样 —— 删除只是改文件名（能从磁盘捞回来），关闭是直接把内容丢掉，没有文件。
 * 所以弹窗里直接写明「想留下请先保存为正式对话」，别让人点错了才发现找不回来。
 */
import { forgetCachedMessages } from "./session-cache.ts";
import { forgetDraft } from "./store.ts";
import { closeEphemeral } from "./ws.ts";

export function discardEphemeralChat(conversationId: string): void {
	void forgetCachedMessages(conversationId); // 本地缓存的正文也一并删掉
	// 这条会话彻底没了，它那一格草稿也丢掉（不丢的话也再没有人能把它写回输入框）
	forgetDraft(conversationId);
	closeEphemeral(conversationId);
}
