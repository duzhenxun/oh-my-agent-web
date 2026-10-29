/**
 * 临时会话「转正」（界面上那颗「保存为正式对话」）。
 *
 * 临时会话只活在引擎的内存里：跑得通、看得见，但**一个字都不在磁盘上**。
 * 转正 = 把内存里的条目写成一个真正的会话文件，id 不变 —— 于是它立刻出现在历史列表里，
 * 也能被 pi CLI 看见。
 *
 * 两个前提必须显式挡住，否则会静默丢东西：
 *   - 回合还在跑：转正要关掉内存句柄重开，跑到一半关掉等于把一轮对话拦腰砍断；
 *   - 会话是空的：标题都没有的会话进历史只多一个没法看的空行。
 */
import type { EnginePort } from "../engine/port.js";
import type { ConversationMeta } from "../protocol.js";

type PersistResult = { ok: true } | { ok: false; error: { code: string; message: string } };

export function createPersistConversation(deps: {
	engine: EnginePort;
	conversations: () => ConversationMeta[];
	/** 落盘成功后重新登记会话文件路径（列表 / 统计 / 改名都靠它） */
	register: (input: { id: string; sessionPath: string; title: string; workspace: string }) => void;
	refreshSessions: (force?: boolean) => Promise<void>;
	/** 清掉会话上的「临时」标记（转正之后界面就不该再显示提示条） */
	clearEphemeral: (conversationId: string) => void;
	isBusy: (conversationId: string) => boolean;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}) {
	return async (conversationId: string): Promise<PersistResult> => {
		const conversation = deps.conversations().find((item) => item.id === conversationId);
		if (!conversation) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}
		// 已经不是临时会话了：当成成功（客户端可能连点了两下）
		if (!conversation.ephemeral) return { ok: true };
		if (!deps.engine.persistSession) {
			return {
				ok: false,
				error: { code: "engine.unsupported", message: "当前引擎不支持把临时对话保存为正式对话" },
			};
		}
		if (deps.isBusy(conversationId)) {
			return {
				ok: false,
				error: { code: "session.busy", message: "这一轮还在跑，等它结束后再保存" },
			};
		}

		let sessionPath: string | null = null;
		try {
			({ sessionPath } = await deps.engine.persistSession(conversationId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`保存为正式对话失败：${message}`, "error");
			return { ok: false, error: { code: "session.persist_failed", message } };
		}
		if (!sessionPath) {
			deps.notice("这条临时对话还是空的，没有可以保存的内容", "warn");
			return { ok: false, error: { code: "session.empty", message: "空会话不需要保存" } };
		}

		deps.register({
			id: conversationId,
			sessionPath,
			title: conversation.title,
			workspace: conversation.workspace,
		});
		deps.clearEphemeral(conversationId);
		deps.notice("✅ 已保存为正式对话，现在可以在历史记录里找到它", "info");
		// 重扫列表：会话文件刚写出来，磁盘清单里还没有它
		void deps.refreshSessions(true).catch(() => undefined);
		deps.pushSnapshot();
		return { ok: true };
	};
}
