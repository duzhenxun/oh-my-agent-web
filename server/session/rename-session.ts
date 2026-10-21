/**
 * 改会话显示名（ADR-0021：**会话的事实源是 pi 的会话文件**，名字也一样）。
 *
 * 所以不存本地变量（不再写 settings.sessionPrefs.titles），而是往会话文件追加一条
 * `session_info`（pi 自己的「会话显示名」条目）—— pi CLI 里看到的也是这个名字。
 * 写完立刻重扫列表，让侧栏拿到新名字。
 */
import type { EnginePort } from "../engine/port.js";

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

export function renameSessionWith(deps: {
	engine: EnginePort;
	pathOf: (conversationId: string) => string | null;
	refresh: () => Promise<void>;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}): (conversationId: string, title: string) => Promise<Result> {
	return async (conversationId, title) => {
		const sessionPath = deps.pathOf(conversationId);
		if (!sessionPath) {
			return { ok: false, error: { code: "session.not_found", message: `找不到会话文件：${conversationId}` } };
		}
		if (!deps.engine.renameSession) {
			return { ok: false, error: { code: "session.rename_unsupported", message: "当前引擎不支持改会话名" } };
		}
		try {
			await deps.engine.renameSession(sessionPath, title);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`重命名失败：${message}`, "error");
			return { ok: false, error: { code: "session.rename_failed", message } };
		}
		await deps.refresh();
		deps.pushSnapshot();
		return { ok: true };
	};
}
