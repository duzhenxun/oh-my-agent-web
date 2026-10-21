/**
 * 切换会话（从 runtime.ts 抽出：400 行护栏）。
 *
 * 两件事必须一起做：
 *   1. 记下「这个客户端在看哪」—— 多标签/多设备各看各的（ADR-0033）；
 *   2. 更新全局 activeId 与 files.root —— `stats` / `models` / `files` 目前按全局会话算，
 *      不更新就会出现「token 面板空、模型未就绪、文件树停在旧目录」。
 */
import type { UiMessage } from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import type { ClientView } from "./client-view.js";

export type SwitchDeps = {
	state: ServerState;
	clientView: ClientView;
	infoOf: (conversationId: string) => { workspace: string } | null;
	open: (conversationId: string, refresh: (force: boolean) => Promise<void>) => Promise<UiMessage[] | null>;
	refreshSessions: (force: boolean) => Promise<void>;
	refreshModels: (conversationId: string) => Promise<void>;
	refreshThinking: (conversationId: string) => Promise<void>;
	refreshStats: () => void;
	pushSnapshot: () => void;
};

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

export function createSwitchConversation(deps: SwitchDeps) {
	const { state, clientView } = deps;

	async function switchTo(conversationId: string, clientId?: string): Promise<Result> {
		// 每个客户端各记一份视图（互不影响）
		if (clientId) clientView.setActive(clientId, conversationId);
		const mine = state.conversations.some((conversation) => conversation.id === conversationId);
		const fromPi = deps.infoOf(conversationId);
		if (!mine && !fromPi) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}

		if (!mine && fromPi) {
			if (state.activeId !== conversationId || !state.messages[conversationId]) {
				const messages = await deps.open(conversationId, (force) => deps.refreshSessions(force));
				if (messages === null) {
					return { ok: false, error: { code: "session.open_failed", message: `打开会话失败：${conversationId}` } };
				}
				state.messages[conversationId] = messages;
				await deps.refreshModels(conversationId);
				await deps.refreshThinking(conversationId);
				state.activeId = conversationId;
				state.files = { root: fromPi.workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
				deps.pushSnapshot();
			}
			deps.refreshStats();
			return { ok: true };
		}
		if (state.activeId !== conversationId) {
			state.activeId = conversationId;
			// 自建会话也要给出文件根，否则文件树一直是空的
			const workspace = state.conversations.find((item) => item.id === conversationId)?.workspace;
			if (workspace && state.files?.root !== workspace) {
				state.files = { root: workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			}
			deps.pushSnapshot();
		}
		deps.refreshStats();
		return { ok: true };
	}

	return switchTo;
}
