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

type SwitchDeps = {
	state: ServerState;
	clientView: ClientView;
	infoOf: (conversationId: string) => { workspace: string } | null;
	open: (conversationId: string, refresh: (force: boolean) => Promise<void>) => Promise<UiMessage[] | null>;
	refreshSessions: (force: boolean) => Promise<void>;
	refreshModels: (conversationId: string) => Promise<void>;
	refreshThinking: (conversationId: string) => Promise<void>;
	refreshStats: () => void;
	/** 上一个会话不再看了：让引擎放开写锁（codex）；有回合在跑时不调用 */
	parkPrevious: (conversationId: string) => void;
	pushSnapshot: () => void;
};

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

export function createSwitchConversation(deps: SwitchDeps) {
	const { state, clientView } = deps;

	async function switchTo(conversationId: string, clientId?: string): Promise<Result> {
		const previous = state.activeId;
		const mine = state.conversations.some((conversation) => conversation.id === conversationId);
		const fromPi = deps.infoOf(conversationId);
		// 先校验再动状态：以前 parkPrevious / 清建议 / 改客户端视图都在校验之前，
		// 点一条已删除的会话会把**当前**会话停泊掉（codex 放开写锁）、建议被清空，
		// 而界面还停在错误提示上 —— 副作用全白做了。
		if (!mine && !fromPi) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}
		if (previous && previous !== conversationId) {
			deps.parkPrevious(previous);
			// 建议按会话各存一份：切走**不用清**，切回来还是那批（以前全局一份，切走只能清掉）
		}
		// 每个客户端各记一份视图（互不影响）
		if (clientId) clientView.setActive(clientId, conversationId);
		// 统计先换成本会话的缓存（没有就清空）：refreshStats 是异步的，不先换的话
		// 这一帧快照里还是**上一个会话**的 token 数（新会话看着像"有记录"）。
		state.sessionStats = state.statsByConversation[conversationId] ?? null;

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
			}
			// 无论有没有真的换（已是当前会话也推）：客户端靠这份快照把乐观高亮退掉，
			// 否则点一下当前会话就变成「正在打开…」卡在那里 —— 看着就是「点了没反应」。
			deps.pushSnapshot();
			return { ok: true };
		}
		if (state.activeId !== conversationId) {
			state.activeId = conversationId;
			// 自建会话也要给出文件根，否则文件树一直是空的
			const workspace = state.conversations.find((item) => item.id === conversationId)?.workspace;
			if (workspace && state.files?.root !== workspace) {
				state.files = { root: workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			}
			// 模型选择器是全局一份，切会话必须把「这个会话当前用哪个模型」读回来，
			// 否则会一直显示上一个会话的模型（看着就像「选的模型没生效」）。
			await deps.refreshModels(conversationId);
			// 思考强度也是「每个会话一份」：自建会话同样要读回来，否则切来切去显示的是上一个会话的
			await deps.refreshThinking(conversationId);
		}
		deps.refreshStats();
		// 同一个理由：已经是当前会话也要推一份，客户端才知道「切到了」。
		deps.pushSnapshot();
		return { ok: true };
	}

	return switchTo;
}
