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
	/** 耗时上报（写入启动日志/文件日志，定位「切会话慢」用） */
	report: (text: string) => void;
	pushSnapshot: () => void;
};

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

/** 耗时上报：`switch <id> 总 123ms · open=100ms models=10ms …`（只进日志，不进对话流） */
function report(deps: SwitchDeps, conversationId: string, began: number, laps: string[]): void {
	deps.report(`switch ${conversationId.slice(0, 12)} 总 ${Date.now() - began}ms · ${laps.join(" ")}`);
}

export function createSwitchConversation(deps: SwitchDeps) {
	const { state, clientView } = deps;

	async function switchTo(conversationId: string, clientId?: string): Promise<Result> {
		const began = Date.now();
		const laps: string[] = [];
		const lap = (label: string, from: number) => laps.push(`${label}=${Date.now() - from}ms`);
		// 每个客户端各记一份视图（互不影响）
		if (clientId) clientView.setActive(clientId, conversationId);
		const mine = state.conversations.some((conversation) => conversation.id === conversationId);
		const fromPi = deps.infoOf(conversationId);
		if (!mine && !fromPi) {
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}

		if (!mine && fromPi) {
			if (state.activeId !== conversationId || !state.messages[conversationId]) {
				const tOpen = Date.now();
				const messages = await deps.open(conversationId, (force) => deps.refreshSessions(force));
				lap("open", tOpen);
				if (messages === null) {
					return { ok: false, error: { code: "session.open_failed", message: `打开会话失败：${conversationId}` } };
				}
				state.messages[conversationId] = messages;
				const tModels = Date.now();
				await deps.refreshModels(conversationId);
				lap("models", tModels);
				const tThinking = Date.now();
				await deps.refreshThinking(conversationId);
				lap("thinking", tThinking);
				state.activeId = conversationId;
				state.files = { root: fromPi.workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			}
			const tStats = Date.now();
			deps.refreshStats();
			lap("stats", tStats);
			// 无论有没有真的换（已是当前会话也推）：客户端靠这份快照把乐观高亮退掉，
			// 否则点一下当前会话就变成「正在打开…」卡在那里 —— 看着就是「点了没反应」。
			deps.pushSnapshot();
			report(deps, conversationId, began, laps);
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
			const tModels2 = Date.now();
			await deps.refreshModels(conversationId);
			lap("models", tModels2);
		}
		const tStats2 = Date.now();
		deps.refreshStats();
		lap("stats", tStats2);
		// 同一个理由：已经是当前会话也要推一份，客户端才知道「切到了」。
		deps.pushSnapshot();
		report(deps, conversationId, began, laps);
		return { ok: true };
	}

	return switchTo;
}
