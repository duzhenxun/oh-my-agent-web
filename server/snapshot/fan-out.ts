/**
 * 快照扇出（ADR-0033）：一份状态，按客户端各生成一份快照。
 *
 * 每个 SSE 客户端拿「自己选中会话」的那份，这样两个标签页 / 本地与远程同时开着
 * 也不会互相拽着切换。（WS 通道已移除：客户端是纯 HTTP/SSE，见 web/src/ws.ts 文件头。）
 */
import type { Snapshot } from "../protocol.js";

type FanOutTargets = {
	sinks: Map<string, (payload: string) => void>;
	snapshotFor: (clientId: string) => Snapshot;
};

export function fanOutSnapshot(snapshot: Snapshot, targets: FanOutTargets): void {
	for (const [clientId, sink] of targets.sinks) {
		sink(JSON.stringify({ type: "event", event: "snapshot", snapshot: targets.snapshotFor(clientId) }));
	}
}
