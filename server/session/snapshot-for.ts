/**
 * 「给某个客户端生成一份快照」（从 runtime 抽出来：400 行护栏，ADR-0010）。
 *
 * 两件事按客户端各算一份（ADR-0033）：
 *   1. `active` 用这个客户端自己选中的会话；
 *   2. pi 会话清单（上百 KB、几乎不变）只在这个客户端需要时才带 —— 见 client-view.ts。
 */
import type { Snapshot } from "../protocol.js";
import { buildSnapshot, type ServerState } from "../snapshot/state.js";
import type { ClientView } from "./client-view.js";

type SnapshotForDeps = {
	state: ServerState;
	clientView: ClientView;
	now: () => number;
};

export function createSnapshotFor(deps: SnapshotForDeps): (clientId: string | undefined) => Snapshot {
	const { state, clientView, now } = deps;
	return (clientId) =>
		buildSnapshot(state, undefined, clientView.activeFor(clientId, state.activeId), {
			includeProjects: clientView.needsProjects(clientId, state.piProjectsVersion, now()),
		});
}
