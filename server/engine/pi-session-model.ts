/**
 * 「这个会话持久化的是哪个模型」——读会话条目里**最后一条** `model_change`。
 *
 * 为什么不用 SDK 的 `session.model`：续聊历史会话时它常常还是进程默认模型，
 * 界面就会显示成「别的模型」，看起来像「选了模型没生效」（真实踩过）。
 * 为什么会话文件里是这个：用户在模型选择器上切换时 SDK 就写一条 `model_change`，
 * 所以它既是「当前模型」也是「下次续聊用的模型」。
 */
export function readSessionModel(handle: { sessionManager?: { getEntries?: () => unknown[] } } | undefined): {
	provider: string;
	model: string;
} | null {
	const entries = handle?.sessionManager?.getEntries?.() ?? [];
	// 倒着找：追加式文件，最后一条就是当前生效的
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as Record<string, unknown> | undefined;
		if (entry?.type !== "model_change") continue;
		const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
		if (modelId === "") continue;
		const provider = typeof entry.provider === "string" ? entry.provider : "?";
		return { provider, model: modelId };
	}
	return null;
}
