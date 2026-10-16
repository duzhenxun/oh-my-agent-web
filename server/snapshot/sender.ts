/**
 * 发送侧：节流 + 背压（ADR-0004 §3/§4）。
 *
 * 两条铁律：
 *   1. **快照按窗口合并**（默认 60ms）——中间帧允许丢，永远只保留「最新一份」；
 *   2. **应答与事件绝不丢**——它们不是幂等的，丢了就是状态错乱或界面卡死。
 *
 * 因此：
 *   - `pushSnapshot` 覆盖待发快照（丢的是中间帧，不是状态）；
 *   - `pushEvent` / `pushReply` 立即发；
 *   - `setBusy(true)`（socket 积压）时**跳过快照**但仍然发事件：积压一解除，
 *     下一帧快照会把状态一次性收敛回去 —— 这就是「快照可丢」为什么安全。
 *
 * 时间由外部通过 `tick(now)` 注入（不自己开 timer），因此单测完全确定。
 */
import type { ServerEvent, ServerReply, Snapshot } from "../protocol.js";

export const DEFAULT_WINDOW_MS = 60;

export type OutFrame =
	| { kind: "snapshot"; snapshot: Snapshot }
	| { kind: "event"; event: ServerEvent }
	| { kind: "reply"; reply: ServerReply };

export type SenderStats = {
	sentSnapshots: number;
	/** 因为窗口内已有待发快照而被覆盖掉的帧数（= 真正丢掉的中间帧） */
	coalescedSnapshots: number;
	/** 因为 socket 积压而压根没发的快照次数 */
	skippedSnapshots: number;
	sentEvents: number;
	sentReplies: number;
};

export type Sender = {
	pushSnapshot(snapshot: Snapshot): void;
	pushEvent(event: ServerEvent): void;
	pushReply(reply: ServerReply): void;
	/** 由宿主按固定节奏调用（例如 20ms 一次） */
	tick(now: number): void;
	setBusy(busy: boolean): void;
	/** 立即把待发快照发出去（关机/测试用） */
	flush(now: number): void;
	stats(): SenderStats;
	hasPendingSnapshot(): boolean;
};

export type SenderOptions = {
	send: (frame: OutFrame) => void;
	windowMs?: number;
};

export function createSender(options: SenderOptions): Sender {
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const stats: SenderStats = {
		sentSnapshots: 0,
		coalescedSnapshots: 0,
		skippedSnapshots: 0,
		sentEvents: 0,
		sentReplies: 0,
	};

	let pending: Snapshot | null = null;
	let lastSentAt = Number.NEGATIVE_INFINITY;
	let busy = false;

	const sendNow = () => {
		if (!pending) return false;
		options.send({ kind: "snapshot", snapshot: pending });
		pending = null;
		stats.sentSnapshots += 1;
		return true;
	};

	return {
		pushSnapshot(snapshot) {
			if (pending) stats.coalescedSnapshots += 1;
			pending = snapshot;
		},

		pushEvent(event) {
			options.send({ kind: "event", event });
			stats.sentEvents += 1;
		},

		pushReply(reply) {
			options.send({ kind: "reply", reply });
			stats.sentReplies += 1;
		},

		tick(now) {
			if (!pending) return;
			if (busy) {
				stats.skippedSnapshots += 1;
				return;
			}
			if (now - lastSentAt < windowMs) return;
			if (sendNow()) lastSentAt = now;
		},

		setBusy(next) {
			busy = next;
		},

		flush(now) {
			if (sendNow()) lastSentAt = now;
		},

		stats() {
			return { ...stats };
		},

		hasPendingSnapshot() {
			return pending !== null;
		},
	};
}
