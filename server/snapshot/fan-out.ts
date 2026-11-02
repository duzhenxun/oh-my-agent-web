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

export type FanOutStats = {
	/** 这次扇出给了几个客户端（每个一份独立快照） */
	clients: number;
	/** 序列化后的总字符数（UTF-16 code unit）：手机上几百 KB 的快照就是卡顿的来源 */
	bytes: number;
	/** 扇出总耗时（包含每个客户端的 `buildSnapshot` + `JSON.stringify`） */
	ms: number;
};

export function fanOutSnapshot(snapshot: Snapshot, targets: FanOutTargets): FanOutStats {
	const startedAt = performance.now();
	let bytes = 0;
	let clients = 0;
	for (const [clientId, sink] of targets.sinks) {
		const payload = JSON.stringify({ type: "event", event: "snapshot", snapshot: targets.snapshotFor(clientId) });
		bytes += payload.length;
		clients += 1;
		sink(payload);
	}
	return { clients, bytes, ms: Math.round(performance.now() - startedAt) };
}
