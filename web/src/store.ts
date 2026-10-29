/**
 * 前端状态：一份服务端快照 + 两个连接期字段（ADR-0008：模块级 store + useSyncExternalStore，
 * 不引状态管理库；ADR-0012：快照是渲染的唯一事实源，前端不自造权威状态）。
 */
import { useSyncExternalStore } from "react";
import type { Snapshot, UiMessage } from "./types.ts";
import { focusComposer } from "./composer-focus.ts";

type ConnectionState = "connecting" | "open" | "closed";

type AppState = {
	snapshot: Snapshot | null;
	connection: ConnectionState;
	/**
	 * 最近一次失败请求的提示。
	 *
	 * `conversationId` = 出错时正在看的那个会话（null = 与服务无关，例如连不上服务端）。
	 * 以前只存一个字符串，换了会话它还在 —— 表现就是「别人的错挂在当前对话下面」。
	 */
	lastError: { text: string; conversationId: string | null } | null;
	/** 输入框草稿（纯客户端状态；ADR-0012 明确它不进快照） */
	draft: string;
	/** 侧栏的设置面板是否展开（同理：纯客户端 UI 状态） */
	settingsOpen: boolean;
	/** 刚点下、还没等到快照的会话：让侧栏立刻高亮（外网切换有几百毫秒延迟） */
	pendingActive: string | null;
	/** 刚点了「新会话」、服务端还没建完：给一条「正在新建」的反馈（id 由服务端生成，还没法先高亮） */
	creating: boolean;
	/**
	 * 「新会话界面」：点了「新会话」之后屏幕上那一屏（空对话 + 输入框 + 项目/分支选择），
	 * **服务端什么都还没建**。
	 *
	 * 它不是「草稿会话」——没有 id、没有会话文件、列表里也不会多出一行；只是
	 * 「还没发起的新会话」这一屏要显示的东西：待建会话落在哪个项目（`workspace`）。
	 * 用户**发出第一条消息**的那一刻才真去 `new_chat`（`ws.ts` 的 `createSessionAndSend`），
	 * 这也是用户要求的：别每点一次「新会话」，项目列表里就多一条空会话。
	 *
	 * 纯客户端状态（跟输入框的 `draft` 同一类）：它描述的是「界面上正在填的东西」，
	 * 不是会话本身，所以不进快照（ADR-0012）。刷新即丢：这时候确实什么都还没发起。
	 */
	newSession: { workspace: string | null; ephemeral: boolean } | null;
	/**
	 * 本地缓存先铺上的会话正文（见 session-cache.ts）。
	 * 只是「预览」：服务端快照一到就退休（清成 null），权威数据永远在 snapshot 里。
	 */
	preview: { conversationId: string; messages: UiMessage[] } | null;
};

let state: AppState = {
	snapshot: null,
	connection: "connecting",
	lastError: null,
	draft: "",
	settingsOpen: false,
	pendingActive: null,
	creating: false,
	newSession: null,
	preview: null,
};
const listeners = new Set<() => void>();

export function getAppState(): AppState {
	return state;
}

export function setDraft(draft: string): void {
	setAppState({ draft });
}

/**
 * 进「新会话界面」：**不建会话**，只把界面切到空对话 + 选项目的那一屏。
 *
 * `workspace` = 已经知道要在哪个项目下建（项目行的「+」「新建项目」）；
 * 不传就是「还不属于任何项目」（抬头那颗「新会话」）。
 * 光标得在点击的同一个任务里抢进输入框（iOS 只认用户手势，见 composer-focus.ts）。
 */
export function startNewSession(workspace?: string | null): void {
	focusComposer();
	// 没显式指定（＝抬头那颗「新会话」）就预选**当前这条会话所在的项目**：
	// 服务端建会话时本来也会继承它（`conversation-create.ts` 的优先级），
	// 所以这一行先把「实际会落在哪儿」照实显示出来，想换再换 ——
	// 而不是先挂一句「不在项目中工作」，结果发出去还是落在当前项目。
	const current = getAppState().snapshot?.files?.root ?? null;
	setAppState({ newSession: { workspace: workspace === undefined ? current : workspace, ephemeral: false } });
}

/** 换项目（输入框上方那个下拉框选完）：只改「这条新会话放哪」，服务端仍什么都没建 */
export function setNewSessionWorkspace(workspace: string | null): void {
	const current = getAppState().newSession;
	if (!current) return;
	setAppState({ newSession: { ...current, workspace } });
}

/**
 * 「临时会话（不保存）」：这条新会话建成 pi 的 `--no-session` —— 纯内存、不落盘、不进历史。
 *
 * 注意它**只改「要不要落盘」，不改「落在哪个项目」**：引擎必须有 cwd 才跑得动，
 * 所以目录仍然继承上面选的那个项目。两项互不影响：先开临时、再换项目都成立。
 */
export function setNewSessionEphemeral(ephemeral: boolean): void {
	const current = getAppState().newSession;
	if (!current) return;
	setAppState({ newSession: { ...current, ephemeral } });
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

/** 最近一次渲染出来的会话正文（给 `/copy` 这类"够不着组件树"的地方用；没有就空数组） */
let lastMessages: UiMessage[] = [];
export function rememberMessages(messages: UiMessage[]): void {
	lastMessages = messages;
}
export function lastSeenMessages(): UiMessage[] {
	return lastMessages;
}
