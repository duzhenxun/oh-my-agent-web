/**
 * 「下一步」：让模型基于当前上下文再给一批建议（从 runtime 抽出：400 行护栏）。
 *
 * 三个约束都在这里：
 *   1. **隐藏回合**：不加用户/助手消息（历史回放也会滤掉哨兵），界面上只看到按钮刷新；
 *   2. **超时**：默认 20 秒没想出来就中断，别让隐藏回合一直挂着（表现是「按钮点了没反应」）；
 *   3. **忙就拒**：已经有一轮在跑（或上一条「下一步」还没回来）时直接回 `session.busy`。
 */
import type { EnginePort } from "../engine/port.js";
import type { ActionItem, ProtocolError } from "../protocol.js";
import { buildRefreshActionsPrompt } from "../markers/actions.js";
import type { ServerState } from "../snapshot/state.js";

export type RefreshActionsDeps = {
	state: ServerState;
	turns: Map<string, { messageId: string }>;
	engine: EnginePort;
	notice: (text: string, level?: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
	/** 发一个**隐藏**回合（不落消息），resolve 表示这一轮结束 */
	sendTurn: (prompt: string, conversationId: string) => Promise<{ ok: true } | { ok: false; error: ProtocolError }>;
	/** 超时毫秒（默认 20s）；0 = 不设超时。传函数则每次现读（设置面板改完立即生效） */
	timeoutMs?: number | (() => number);
};

export function createRefreshActions(deps: RefreshActionsDeps) {
	const { state } = deps;
	const resolveTimeout = (): number => {
		const value = typeof deps.timeoutMs === "function" ? deps.timeoutMs() : deps.timeoutMs;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 20_000;
	};

	return async (requested?: string, count?: number): Promise<{ ok: true } | { ok: false; error: ProtocolError }> => {
		const conv = requested ?? state.activeId;
		if (!conv) return { ok: false, error: { code: "session.none", message: "先打开一个会话再要建议" } };
		if (deps.turns.has(conv)) {
			// 可能是真的在跑一轮，也可能是上一次「下一步」还没回来
			return { ok: false, error: { code: "session.busy", message: "上一轮还在跑，等它结束再点「下一步」" } };
		}

		const labels: string[] = state.actions.map((action: ActionItem) => action.label);
		const prompt = buildRefreshActionsPrompt(labels, count);
		state.actions = [];
		deps.pushSnapshot();

		const timeoutMs = resolveTimeout();
		let timedOut = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						if (!deps.turns.has(conv)) return;
						timedOut = true;
						void deps.engine.interrupt(conv).catch(() => undefined);
					}, timeoutMs)
				: null;
		try {
			const result = await deps.sendTurn(prompt, conv);
			if (timedOut) deps.notice(`「下一步」${Math.round(timeoutMs / 1000)} 秒没想出来，已取消（可以再点一次）`, "warn");
			return result;
		} finally {
			if (timer !== null) clearTimeout(timer);
			deps.pushSnapshot();
		}
	};
}
