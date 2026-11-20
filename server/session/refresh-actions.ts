/**
 * 「下一步」：让模型基于当前上下文再给一批建议（从 runtime 抽出：400 行护栏）。
 *
 * **不走隐藏回合**：「想想」只要一段文本，不需要工具、审批、回合。
 * 以前靠 `sendTurn` 发一条哨兵消息再让历史回放滤掉它 —— 那条消息会真落盘，
 * 而且会和用户正在跑的回合抢会话（于是要报 `session.busy`）。
 * 现在直接调一次性补全，上下文自己拼进提示词。
 *
 * 三个约束：
 *   1. **不写会话**：不产生任何用户/助手消息；
 *   2. **超时**：默认 20 秒没想出来就放弃（表现是「按钮点了没反应」）；
 *   3. **不抢回合**：用户正在跑一轮也照样能点（补全不碰引擎会话）。
 */
import type { ActionItem, ProtocolError } from "../protocol.js";
import { buildRefreshActionsPrompt, reduceActionMarkers } from "../markers/actions.js";
import { actionsOf, setActionsOf, type ServerState } from "../snapshot/state.js";
import type { CompleteTextInput, TextCompletion } from "./one-shot.js";

type RefreshActionsDeps = {
	state: ServerState;
	notice: (text: string, level?: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
	/** 「想想」用的模型：跟标题/模板同一个补全入口 */
	completeText: (input: CompleteTextInput) => Promise<TextCompletion>;
	/** 这条会话的对话正文（压好的一段），拼进提示词 */
	transcriptOf: (conversationId: string) => Promise<string>;
	nextId: () => string;
	/** 超时毫秒（默认 20s）；0 = 不设超时。传函数则每次现读（设置面板改完立即生效） */
	timeoutMs?: number | (() => number);
};

/** 给「想想」的系统提示词：教它只输出建议标记，不要正文 */
const THINK_SYSTEM = [
	"你在给用户推荐下一步可以做的事。",
	"只输出建议标记，每行一条：[[action:suggest:按钮文字]]，不要任何正文、解释或编号。",
	"按钮文字用祈使句，具体到能直接执行，不要「继续」「下一步」这类空话。",
	"按钮文字要短（十几字以内），**不要**把 prompt= 写进按钮文字里。",
	"如果按钮文字和要发送的指令不同，写成 [[action:suggest:按钮文字,prompt=完整指令]]；prompt= 后面可以带逗号，只写一次。",
].join("\n");

export function createRefreshActions(deps: RefreshActionsDeps) {
	const { state } = deps;
	const resolveTimeout = (): number => {
		const value = typeof deps.timeoutMs === "function" ? deps.timeoutMs() : deps.timeoutMs;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 20_000;
	};

	return async (requested?: string, count?: number): Promise<{ ok: true } | { ok: false; error: ProtocolError }> => {
		const conv = requested ?? state.activeId;
		if (!conv) return { ok: false, error: { code: "session.none", message: "先打开一个会话再要建议" } };

		const labels: string[] = actionsOf(state, conv).map((action: ActionItem) => action.label);
		const instruction = buildRefreshActionsPrompt(labels, count);
		let transcript = "";
		try {
			transcript = await deps.transcriptOf(conv);
		} catch {
			// 读不到上下文也还能给建议（只是不够贴合）：不把它当失败
		}
		const prompt = transcript === "" ? instruction : `${transcript}\n\n${instruction}`;

		const timeoutMs = resolveTimeout();
		const timeout = new Promise<TextCompletion>((resolve) => {
			const timer = setTimeout(
				() =>
					resolve({
						ok: false,
						code: "oneshot.timeout",
						message: `「下一步」${Math.round(timeoutMs / 1000)} 秒没想出来`,
					}),
				timeoutMs,
			);
			// 不阻塞进程退出
			if (typeof timer.unref === "function") timer.unref();
		});

		const result = await Promise.race([
			deps.completeText({ conversationId: conv, prompt, system: THINK_SYSTEM }),
			timeoutMs > 0 ? timeout : new Promise<TextCompletion>(() => undefined),
		]);
		if (!result.ok) return { ok: false, error: { code: result.code, message: result.message } };

		// 模型可能只回标记、也可能带点正文：先按标记语法归约，再只留建议
		const reduced = reduceActionMarkers(result.text, [], deps.nextId);
		const actions = reduced.actions.slice(-5);
		if (actions.length === 0) {
			return { ok: false, error: { code: "actions.empty", message: "模型没有给出可用的建议，再点一次试试" } };
		}
		setActionsOf(state, conv, actions);
		deps.pushSnapshot();
		return { ok: true };
	};
}
