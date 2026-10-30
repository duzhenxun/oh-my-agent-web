/**
 * 把「跑完了、你还没看」接进 React：
 *
 * - `useUnseenFinishWatch()`：App 里调一次，负责喂帧（快照 / 页面可见性变化）；
 * - `useUnseenMarks()`：侧栏订阅这份标记表，画圆点。
 *
 * 判定规则全在 session-unseen.ts 的纯函数里，这里只做接线。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Snapshot } from "./types.ts";
import { getMarks, observeFrame, subscribeMarks, type UnseenMarks } from "./session-unseen.ts";
import { useAppSelector } from "./store.ts";

/** 标记表（订阅式）：侧栏据此在会话行 / 项目行上画圆点 */
export function useUnseenMarks(): UnseenMarks {
	return useSyncExternalStore(subscribeMarks, getMarks, getMarks);
}

function documentVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * 这一帧谁在跑。服务端收尾时会把会话从 `runningByConversation` 里**删掉**（不是置 idle），
 * 所以「跳变」就是这个键消失 —— 别只盯着 status。
 * `snapshot.running` 是当前会话那份全量状态，兜一层：万一某帧只有它更新了也不会漏。
 */
function runningIds(snapshot: Snapshot): string[] {
	const ids = new Set<string>();
	for (const [id, value] of Object.entries(snapshot.runningByConversation ?? {})) {
		if (value.status !== "idle") ids.add(id);
	}
	const active = snapshot.running;
	if (active.status !== "idle" && active.conversationId) ids.add(active.conversationId);
	return [...ids];
}

/** 在 App 里调一次即可 */
export function useUnseenFinishWatch(): void {
	const snapshot = useAppSelector((state) => state.snapshot);
	const [visible, setVisible] = useState(documentVisible);
	const prevRunning = useRef<string[]>([]);

	useEffect(() => {
		const onChange = () => setVisible(documentVisible());
		document.addEventListener("visibilitychange", onChange);
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);

	useEffect(() => {
		if (!snapshot) return;
		const running = runningIds(snapshot);
		observeFrame(prevRunning.current, {
			running,
			activeId: snapshot.active.conversationId,
			visible,
			now: Date.now(),
		});
		prevRunning.current = running;
	}, [snapshot, visible]);
}
