/**
 * 一轮（含自动重试）怎么收尾：算「出错」还是「完成」（纯函数，方便单测）。
 *
 * 旧逻辑只看有没有攒下 provider 报错：只要有一条，整轮就判成 error。
 * 真实翻车：模型已经把答案完整吐完（最后一条助手消息 stopReason=stop），
 * 紧接着又迟到一条 "Connection error."。答案是完整的，界面却只剩一条红条、
 * 回合被标成失败。
 *
 * 新规则：本轮已经正常结束（出现过 stopReason=stop 的助手消息）时，
 * 收到的 provider 报错不再算这一轮失败；报错照常写日志，留给复盘。
 */

/** 这条 SDK 事件是不是「助手正常说完了」：stopReason=stop 即模型给出了最终回答 */
export function isCleanAssistantEnd(event: Record<string, unknown>): boolean {
	if (event.type !== "message_end") return false;
	const message = event.message;
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return record.role === "assistant" && record.stopReason === "stop";
}

export type TurnOutcomeInput = {
	/** 用户点停 / 看门狗中断 */
	aborted: boolean;
	/** 这一轮攒下的 provider 报错条数（含已经被重试掉的） */
	errorCount: number;
	/** 这一轮是否已经正常说完（见 isCleanAssistantEnd） */
	completed: boolean;
};

/** 这一轮是否应当以「出错」收尾（界面红条 + turn_end: error） */
export function turnFailed(input: TurnOutcomeInput): boolean {
	return !input.aborted && input.errorCount > 0 && !input.completed;
}
