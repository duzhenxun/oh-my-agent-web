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
	/** 输入框草稿（纯客户端状态；ADR-0012 明确它不进快照） */
	draft: string;
	/** 侧栏的设置面板是否展开（同理：纯客户端 UI 状态） */
	settingsOpen: boolean;
};

let state: AppState = { snapshot: null, connection: "connecting", lastError: null, draft: "", settingsOpen: false };
const listeners = new Set<() => void>();

export function getAppState(): AppState {
	return state;
}

export function setDraft(draft: string): void {
	setAppState({ draft });
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
