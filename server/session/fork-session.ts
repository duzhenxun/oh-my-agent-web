/**
 * 「从这里创建分支」：从某条消息派生一条新会话，并自动切过去（原会话一个字不动）。
 *
 * 语义上等价于「把这轮对话复制一份到新会话里，接着往下聊」：
 *   - 新会话的历史 = 源会话**从根到这条消息**那条路径；
 *   - 截断由引擎按会话树算（pi 的 `createBranchedSession`，与 CLI 的 `/fork`、`/clone` 同一套）——
 *     助手气泡是多条 entry 合并出来的，按首条切会把这一轮的工具块一起砍掉；
 *   - 落在**同一个工作区**：分支是「同一个项目里的另一条思路」，不该换目录。
 *
 * 为什么必须「先确保源会话在引擎里打开」：派生是按源会话的树裁剪 entry 的，
 * 而引擎只在会话被打开时才持有它的树。用户通常就在这里，所以多数情况下是零成本。
 */
import type { ConversationMeta } from "../protocol.js";
import type { ConversationSeed } from "./conversation-create.js";

type ForkResult =
	{ ok: true; conversationId: string; workspace: string } | { ok: false; error: { code: string; message: string } };

export function createForkSession(deps: {
	create: (seedText: string, workspace?: string, seed?: ConversationSeed) => Promise<string>;
	conversations: () => ConversationMeta[];
	/** 源会话的展示信息（列表里没有时从这里取，例如历史会话） */
	infoOf: (conversationId: string) => { title: string; workspace: string } | null;
	/** 源会话没在引擎里打开时先打开它（派生要按它的会话树裁剪） */
	open: (conversationId: string) => Promise<boolean>;
	clientView: { setActive: (clientId: string, conversationId: string) => void };
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
	refreshSessions: (force?: boolean) => Promise<void>;
}) {
	return async (conversationId: string, messageId: string, clientId?: string): Promise<ForkResult> => {
		const conversation = deps.conversations().find((item) => item.id === conversationId);
		const info = conversation
			? { title: conversation.title, workspace: conversation.workspace }
			: deps.infoOf(conversationId);
		if (!info) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}
		// 临时会话没有会话文件，pi 原生就拒绝 fork（「先说句话再 /clone」）—— 这里提前拦，给得出人话
		if (conversation?.ephemeral) {
			return {
				ok: false,
				error: { code: "session.ephemeral", message: "临时对话不能派生分支，先「保存为正式对话」" },
			};
		}

		const opened = await deps.open(conversationId);
		if (!opened) {
			return { ok: false, error: { code: "session.open_failed", message: "打不开源会话，无法派生分支" } };
		}

		const title = `分支 · ${info.title}`;
		let id: string;
		try {
			id = await deps.create(title, info.workspace, { fork: { sourceConversationId: conversationId, messageId } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`派生分支会话失败：${message}`, "error");
			return { ok: false, error: { code: "session.fork_failed", message } };
		}

		if (clientId) deps.clientView.setActive(clientId, id);
		deps.notice("🌱 已派生新分支会话并自动切换（原对话保持不变）", "info");
		void deps.refreshSessions(true).catch(() => undefined);
		deps.pushSnapshot();
		return { ok: true, conversationId: id, workspace: info.workspace };
	};
}
