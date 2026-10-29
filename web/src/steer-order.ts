import type { UiMessage } from "./types.ts";

/**
 * 「插队」消息在对话流里的**显示位置**。
 *
 * 问题：一轮的输出全部累积在同一条助手消息上，所以服务端只能把插队那句话追加到这一轮**末尾**
 * （顺序是 `[助手(整轮), 我(插队)]`）。可它其实是插在这轮**中间**的 —— 助手后面那段说不定就是在
 * 回答它。于是界面看着像「先答后问」，气泡上还挂着「插队」标签，很别扭。
 *
 * 修法只动显示层：把插队那条挪到**它打断的那条助手消息前面**。
 * 判据三条，都满足才挪：
 *   1. 这一条是插队用户消息（`steer`）；
 *   2. 它前面**紧挨着**一条助手消息；
 *   3. 这条插队的时间落在那条助手消息的时间区间里（`ts <= 插队时间 <= endedAt ?? ∞`）。
 *      正常在下一轮发的消息，时间一定晚于上一条助手消息的 `endedAt`，所以不会被误挪。
 *
 * 为什么不做成服务端在注入时切分消息：那要动事件归位（"后续输出进哪条"）、回合收尾、
 * 工具卡跨切分的回填 —— 为一句「排在哪儿」不值当。显示层重排没有这些牵连：
 * 数据一字不改，只是画的时候换个位置。
 *
 * 现有约定：`[助手A, 插队1, 插队2]` 会连续挪成 `[插队1, 插队2, 助手A]`（按到达顺序）。
 */
export function liftSteeredMessages(messages: UiMessage[]): UiMessage[] {
	if (messages.length < 2) return messages;
	let result = messages;
	// 一条插队最多往前挪一位；挪完还要继续看后面几条（可能有连着插的），所以扫到不动为止
	for (let pass = 0; pass < messages.length; pass += 1) {
		let moved = false;
		const next = [...result];
		for (let index = 1; index < next.length; index += 1) {
			const steer = next[index];
			const before = next[index - 1];
			if (!steer || !before) continue;
			if (steer.role !== "user" || steer.steer !== true) continue;
			if (before.role !== "assistant") continue;
			// 助手消息的时间区间：开始时 ts，跑完是 endedAt（还在跑就没有上界）
			const startedAt = before.ts;
			const endedAt = before.endedAt ?? Number.POSITIVE_INFINITY;
			if (steer.ts < startedAt || steer.ts > endedAt) continue;
			next[index - 1] = steer;
			next[index] = before;
			moved = true;
		}
		result = next;
		if (!moved) break;
	}
	return result;
}
