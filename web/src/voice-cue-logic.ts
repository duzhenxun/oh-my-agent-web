/**
 * 「该播什么」的判定（纯函数，无 React、无音频）。
 *
 * 抽出来的原因：这段逻辑以前只存在于 hook 里，而它要处理的是**服务端状态机的边角**
 * （审批会翻转、收尾顺序会重排、后台会话还会并行跑），错一次用户就会听到重复播报。
 * 拆成纯函数之后可以用合成快照序列直接回归（见 `npm run check:cues`）。
 *
 * 三条不变式：
 *   1. **一个回合只播一次「完成」** —— 按回合身份去重（当前会话用消息 `(id, endedAt)`，
 *      后台会话用 `turnStartedAt`），而不是「看到一次状态跳变就响一次」；
 *   2. 隐藏回合（「想想」）不播 —— 它不新建助手消息，`isRealTurnEnd` 会把它挡掉；
 *   3. 切会话不算开始/结束 —— 状态按会话 id 分开记，切过去不会把旧状态当成新跳变。
 */
import type { Snapshot, UiMessage } from "./types.ts";

export type Cue =
	| { kind: "start"; conversationId: string }
	| { kind: "done"; conversationId: string; message: UiMessage | null }
	| { kind: "approval" }
	| { kind: "error" };

type TurnMark = { id: string | null; endedAt: number | undefined; turnStartedAt: number | null };

/** hook 里用 ref 持有的那份可变记忆（每次判定后原地更新） */
type CueMemory = {
	prevStatus: Map<string, string>;
	turnStartMark: Map<string, TurnMark | null>;
	/**
	 * 收尾那一拍 `endedAt` 还没落上的会话（服务端 settle 找不到消息时会一直不写）。
	 * 把它们留在这里，下一份快照接着确认 —— 否则这一轮会永远安静地「不响」。
	 */
	awaitingEnd: Map<string, TurnMark | null>;
	announcedTurns: Set<string>;
	startedTurns: Set<string>;
	seenErrors: Set<string>;
	lastApprovalId: string | null;
};

export function createCueMemory(): CueMemory {
	return {
		prevStatus: new Map(),
		turnStartMark: new Map(),
		awaitingEnd: new Map(),
		announcedTurns: new Set(),
		startedTurns: new Set(),
		seenErrors: new Set(),
		lastApprovalId: null,
	};
}

/** 最后一条助手消息（没有就 null） */
function lastAssistant(messages: UiMessage[] | undefined): UiMessage | null {
	if (!messages) return null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && message.role === "assistant") return message;
	}
	return null;
}

/** 这一轮结束是不是「真的回答完了」（隐藏回合不新建消息，所以 id/endedAt 都不变） */
function isRealTurnEnd(before: TurnMark | null, message: UiMessage | null): boolean {
	if (!message) return false;
	if (message.endedAt === undefined) return false;
	// 开跑那一拍还没有助手消息（新会话的第一轮）：冒出一条带 endedAt 的消息就是这轮的新回答。
	// 以前这里直接 return false，于是「刚开的新会话第一次干完活」永远不出声。
	if (!before) return true;
	return message.id !== before.id || message.endedAt !== before.endedAt;
}

const MAX_SEEN = 200;

/**
 * 拿一份快照，算出这一帧要播什么（可能为空）。
 * 副作用只有「更新 memory」，音频/语音由调用方执行。
 */
export function planCues(memory: CueMemory, snapshot: Snapshot): Cue[] {
	const cues: Cue[] = [];
	const activeId = snapshot.active.conversationId;
	const activeMessages = snapshot.active.messages;

	/**
	 * 某个会话此刻的运行状态。
	 *
	 * ⚠️ 收尾时服务端会把这一项从 `runningByConversation` 里**删掉**（不是置 idle），
	 * 所以不能只遍历这张表 —— 那样「跑完」这一跳永远看不到。
	 */
	const statusOf = (conversationId: string): string => {
		const own = snapshot.runningByConversation[conversationId]?.status;
		if (own !== undefined) return own;
		if (snapshot.running.conversationId === conversationId && snapshot.running.status !== "idle") {
			return snapshot.running.status;
		}
		return "idle";
	};
	const startedAtOf = (conversationId: string): number | null =>
		snapshot.runningByConversation[conversationId]?.turnStartedAt ??
		(snapshot.running.conversationId === conversationId ? (snapshot.running.turnStartedAt ?? null) : null);

	/**
	 * 这一轮该不该播「完成」（按回合身份去重）—— 开始/收尾、以及「晚一拍」的补判都走它。
	 */
	const takeDone = (conversationId: string, mark: TurnMark | null, finished: UiMessage | null): boolean => {
		// 不是当前会话（后台跑完）时看不到消息，只能信状态；当前会话还要再确认一次
		const real = conversationId === activeId ? isRealTurnEnd(mark, finished) : true;
		if (!real) return false;
		const turnKey =
			conversationId === activeId && finished
				? `${conversationId}:msg:${finished.id}:${finished.endedAt ?? ""}`
				: `${conversationId}:turn:${mark?.turnStartedAt ?? "?"}`;
		if (memory.announcedTurns.has(turnKey)) return false;
		memory.announcedTurns.add(turnKey);
		trim(memory.announcedTurns);
		return true;
	};

	// ---- 上一拍没收干净的收尾：`endedAt` 当时还没落上，这里接着确认 ----
	if (memory.awaitingEnd.size > 0) {
		// Map 迭代中删当前项是安全的（规范允许），不必先拷一份
		for (const [conversationId, mark] of memory.awaitingEnd) {
			if (conversationId !== activeId) {
				memory.awaitingEnd.delete(conversationId);
				continue;
			}
			const finished = lastAssistant(activeMessages);
			if (finished?.endedAt === undefined) continue; // 还没落上，继续等
			memory.awaitingEnd.delete(conversationId);
			if (takeDone(conversationId, mark, finished)) {
				cues.push({ kind: "done", conversationId, message: finished });
			}
		}
	}

	// ---- 开始 / 结束（逐个会话比状态跳变，再按回合身份去重）----
	const ids = new Set<string>([...memory.prevStatus.keys(), ...Object.keys(snapshot.runningByConversation)]);
	if (activeId !== null) ids.add(activeId);
	for (const conversationId of ids) {
		const before = memory.prevStatus.get(conversationId) ?? "idle";
		const now = statusOf(conversationId);
		memory.prevStatus.set(conversationId, now);
		if (before === now) continue;

		if (now === "streaming" && before !== "streaming") {
			const message = conversationId === activeId ? lastAssistant(activeMessages) : null;
			const startedAt = startedAtOf(conversationId);
			memory.turnStartMark.set(
				conversationId,
				message ? { id: message.id, endedAt: message.endedAt, turnStartedAt: startedAt } : null,
			);
			// 新一轮开始了：上一轮「等 endedAt」的悬案作废（它再落上也已经不是这一轮的事）
			memory.awaitingEnd.delete(conversationId);
			// 同一个回合只响一次「开始」：假的 空闲→流式 跳变不该再响
			const startKey = `${conversationId}:turn:${startedAt ?? "?"}`;
			if (startedAt !== null && memory.startedTurns.has(startKey)) continue;
			memory.startedTurns.add(startKey);
			trim(memory.startedTurns);
			cues.push({ kind: "start", conversationId });
			continue;
		}

		if (before === "streaming" && now !== "streaming") {
			const mark = memory.turnStartMark.get(conversationId) ?? null;
			memory.turnStartMark.delete(conversationId);
			const finished = conversationId === activeId ? lastAssistant(activeMessages) : null;
			// 收尾这一拍 `endedAt` 还没落上：记一笔，等下一份快照补判（不然这一轮永远不响）
			if (conversationId === activeId && finished && finished.endedAt === undefined) {
				memory.awaitingEnd.set(conversationId, mark);
				continue;
			}
			if (takeDone(conversationId, mark, finished)) {
				cues.push({ kind: "done", conversationId, message: finished });
			}
		}
	}

	// ---- 等待审批 ----
	const approvalId = snapshot.pendingApproval?.requestId ?? null;
	if (approvalId !== null && approvalId !== memory.lastApprovalId) {
		memory.lastApprovalId = approvalId;
		cues.push({ kind: "approval" });
	} else if (approvalId === null) {
		memory.lastApprovalId = null;
	}

	// ---- 出错 ----
	const errors = (snapshot.notices ?? []).filter((notice) => notice.level === "error");
	const fresh = errors.find((notice) => !memory.seenErrors.has(notice.id));
	for (const notice of errors) memory.seenErrors.add(notice.id);
	trim(memory.seenErrors);
	if (fresh) cues.push({ kind: "error" });

	return cues;
}

function trim(set: Set<string>): void {
	if (set.size <= MAX_SEEN) return;
	const keep = [...set].slice(-MAX_SEEN);
	set.clear();
	for (const item of keep) set.add(item);
}
