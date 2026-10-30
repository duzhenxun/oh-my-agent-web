/**
 * 前端状态：一份服务端快照 + 两个连接期字段（ADR-0008：模块级 store + useSyncExternalStore，
 * 不引状态管理库；ADR-0012：快照是渲染的唯一事实源，前端不自造权威状态）。
 */
import { useRef, useSyncExternalStore } from "react";
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
	 * 已经发出 `new_chat`、服务端还没把视图切到新会话（见 `ws.ts` 的 `newChat`）。
	 *
	 * 这一小段里屏幕**不能退回上一条会话的正文**（用户 2026-10-30：「新会话第一次发文字，
	 * 屏幕上会闪现一些别的文字，好像串台」）：`new_chat` 只是发出去，服务端把本客户端的视图
	 * 指过去还要一个往返，而那之前 `snapshot.active` 仍是**上一条会话** —— 谁在这个空档去读
	 * `snapshot.active.messages`，读到的就是别人的对话。渲染层的门见 App.tsx 的 `messages`。
	 */
	pendingNewChat: boolean;
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
	pendingNewChat: false,
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

/* ------------------------------------------------------------------------- */
/* 草稿按会话各存一份（切会话不串味，也不丢字）                                    */
/* ------------------------------------------------------------------------- */

/**
 * 「还没建出来的新会话」那一格草稿的槽位名。
 *
 * 用一个不可能撞上会话 id 的字符串（会话 id 是 pi 那种带时间戳的文件名）当作「不是任何会话」：
 * 点「新会话」之后、发出第一条消息之前，用户打的字属于这一屏 —— 它不该记到上一条会话头上，
 * 也不该因为切出去看一眼就没了。
 */
const NEW_SESSION_SLOT = "\u0000new-session";

/** 草稿槽位 → 草稿正文。空串不存（省内存，语义上也一样） */
const drafts = new Map<string, string>();

/** 最多记几份：只是防止开几十条会话后这里无界长；超出按「最久没动过」丢 */
const MAX_STASHED_DRAFTS = 40;

/**
 * 现在输入框里这份草稿归谁：某条会话 id，或 `NEW_SESSION_SLOT`。
 *
 * `null` = 「还没认领」—— 页面刚起来、第一次切会话之前。那时候按当时的界面
 * （新会话屏 / 乐观高亮 / 快照里的当前会话）反推一次，而不是一上来就当成「新会话」。
 */
let draftSlot: string | null = null;

function slotOf(conversationId: string | null): string {
	return conversationId ?? NEW_SESSION_SLOT;
}

function claimDraftSlot(): string {
	if (draftSlot !== null) return draftSlot;
	const state = getAppState();
	draftSlot = state.newSession
		? NEW_SESSION_SLOT
		: slotOf(state.pendingActive ?? state.snapshot?.active.conversationId ?? null);
	return draftSlot;
}

function remember(slot: string, text: string): void {
	drafts.set(slot, text);
	if (drafts.size <= MAX_STASHED_DRAFTS) return;
	// 丢掉最久没动过的那一格（Map 按插入顺序迭代；刚写进去的不会被丢）
	for (const key of drafts.keys()) {
		if (key === slot) continue;
		drafts.delete(key);
		break;
	}
}

/**
 * 切换会话时把输入框草稿「交接」过去：**上一会话存的存回去、下一会话的取出来**。
 *
 * 修的是用户 2026-10-30 报的 bug：「输入框输入文字后，再切会话时，原来会话的输入内容带过来」。
 * 以前 `draft` 只有全局一份：切会话一个字都不动，于是 A 里没发出去的半句话会原样出现在 B 的输入框里 ——
 * 看着像「B 里怎么有这句话」，一按回车就真发给了 B（比看着别扭危险得多）。
 * 而单纯「切会话清空」也不对：跳到别的会话查一眼、回来发现打了半天的字没了，同样难受。
 * 所以两边都要：**各存各的，回来还在**。
 *
 * 存的是内存（不落 localStorage）：草稿描述的是「这一会儿正在填的东西」，
 * 刷新一次连会话正文都要重新拉，草稿跟着清掉反而干净（跟 `draft` 本身原来就不落盘一致）。
 *
 * `nextConversationId = null` = 进「新会话界面」那一格。
 */
export function handoffDraft(nextConversationId: string | null): void {
	const from = claimDraftSlot();
	const to = slotOf(nextConversationId);
	// 同一条会话（例如重连后重新声明一次「我在看哪条」）：一个字都别动
	if (from === to) return;
	if (state.draft === "") drafts.delete(from);
	else remember(from, state.draft);
	draftSlot = to;
	const restored = drafts.get(to) ?? "";
	// 值一样就别 setAppState：切会话本来就要重渲一大片，能省一次是一次
	if (restored !== state.draft) setAppState({ draft: restored });
}

/**
 * 这条会话没了（彻底删除 / 临时会话关掉）：它那一格草稿也不该留着。
 *
 * 不清的话有两个后果：内存里一直挂着一份谁都用不上的字符串；更要紧的是**会话 id 被复用**时
 * （同一路径重新生成），新会话会凭空顶出一句上一个会话没发出去的半句话。
 */
export function forgetDraft(conversationId: string): void {
	drafts.delete(slotOf(conversationId));
	if (draftSlot === slotOf(conversationId)) draftSlot = null;
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
	// 上一条会话没发出去的字先存回它自己那一格：这一屏是新会话的输入框，不该接着写上一句
	// （存的不是「清掉」—— 切回那条会话它还在，见 `handoffDraft`）
	handoffDraft(null);
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

/**
 * 只订阅 state 的某一片。
 *
 * `useAppState()` 是全量订阅：**任何**字段一变，所有订阅者连同整棵子树一起重渲染。
 * 输入框最吃亏 —— `draft` 每敲一个字符就 `setAppState`，于是 App 连着侧栏（几百行项目 / 会话）
 * 和整屏消息一起重渲染，打字先把输入框自己卡住。只取 `snapshot` 的组件必须走这里。
 *
 * `selector` 必须返回**稳定引用**（原始值，或直接挂在 state 上的那个对象 / 数组）：
 * 在里面 `map` / `filter` / 写对象字面量会每次都得到新引用，等于没省。
 */
export function useAppSelector<T>(selector: (state: AppState) => T): T {
	const selectorRef = useRef(selector);
	selectorRef.current = selector;
	/**
	 * 上一次读到的值：`useSyncExternalStore` 每次渲染都要一份快照，
	 * 结果相等但引用不同会让它永远认为「变了」—— 所以在这里做一次 Object.is 归并。
	 */
	const cache = useRef<{ value: T } | null>(null);
	const read = (): T => {
		const next = selectorRef.current(getAppState());
		if (cache.current !== null && Object.is(cache.current.value, next)) return cache.current.value;
		cache.current = { value: next };
		return next;
	};
	return useSyncExternalStore(subscribe, read, read);
}

/** 最近一次渲染出来的会话正文（给 `/copy` 这类"够不着组件树"的地方用；没有就空数组） */
let lastMessages: UiMessage[] = [];
export function rememberMessages(messages: UiMessage[]): void {
	lastMessages = messages;
}
export function lastSeenMessages(): UiMessage[] {
	return lastMessages;
}
