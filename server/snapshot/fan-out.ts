/**
 * 快照扇出（ADR-0033）：一份状态，按客户端各生成一份快照。
 *
 * WS 那条路（内部备选通道）拿全局那份；SSE 客户端各拿「自己选中会话」的那份，
 * 这样两个标签页 / 本地与远程同时开着也不会互相拽着切换。
 */
import type { Snapshot } from "../protocol.js";

export type FanOutTargets = {
	sockets: Set<{ readyState: number; OPEN: number; send: (payload: string) => void }>;
	sinks: Map<string, (payload: string) => void>;
	snapshotFor: (clientId: string) => Snapshot;
};

export function fanOutSnapshot(snapshot: Snapshot, targets: FanOutTargets): void {
	const shared = JSON.stringify({ type: "event", event: "snapshot", snapshot });
	for (const socket of targets.sockets) {
		if (socket.readyState === socket.OPEN) socket.send(shared);
	}
	for (const [clientId, sink] of targets.sinks) {
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: targets.snapshotFor(clientId) }));
	}
}
