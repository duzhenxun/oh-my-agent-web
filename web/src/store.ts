/**
 * 前端状态：一份服务端快照 + 两个连接期字段（ADR-0008：模块级 store + useSyncExternalStore，
 * 不引状态管理库；ADR-0012：快照是渲染的唯一事实源，前端不自造权威状态）。
 */
import { useSyncExternalStore } from "react";
import type { Snapshot } from "./types.ts";

export type ConnectionState = "connecting" | "open" | "closed";

export type AppState = {
	snapshot: Snapshot | null;
	connection: ConnectionState;
	lastError: string | null;
};

let state: AppState = { snapshot: null, connection: "connecting", lastError: null };
const listeners = new Set<() => void>();

export function getAppState(): AppState {
	return state;
}

export function setAppState(patch: Partial<AppState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 订阅整个 state（对象身份只在 setAppState 时变化，因此可安全用于 useSyncExternalStore） */
export function useAppState(): AppState {
	return useSyncExternalStore(subscribe, getAppState, getAppState);
}
