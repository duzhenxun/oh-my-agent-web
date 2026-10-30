/**
 * 实时通道客户端（ADR-0032）：**纯 HTTP**，不用 WebSocket。
 *
 * 两条腿：
 *   - `GET /api/events`（SSE）：服务端 → 浏览器，快照 / 事件 / 增量都走它；
 *   - `POST /api/rpc`：浏览器 → 服务端，一次请求一个 ClientRequest，回包顺手处理。
 *
 * 为什么换成 HTTP：WS 要 Upgrade 头 + 自己的 Origin/Host 白名单，配域名、走反代、
 * 上 https 时处处要额外交代（Basic 凭据在握手阶段还未必带得上）。HTTP 没这些坑，
 * 只要代理能转发普通请求就能用。协议本身一点没改。
 *
 * 断线重连：SSE 自带重连，这里再叠一层指数退避（0.5s → 8s 封顶）。
 */
import { getAppState, handoffDraft, setAppState, setDraft } from "./store.ts";
import { readCachedMessages, writeCachedMessages } from "./session-cache.ts";
import { shareSnapshot } from "./snapshot-share.ts";
import type {
	ApprovalMode,
	AttachmentRef,
	ClientRequest,
	ClientRequestType,
	ProjectPrefs,
	PromptTemplate,
	SendMode,
	ServerMessage,
	SessionPrefs,
	Snapshot,
	SubagentProfileView,
	UiMessage,
} from "./types.ts";
import { focusComposer } from "./composer-focus.ts";
import { appendTextToMessage } from "./lib/delta.ts";
import { sessionUrlFor } from "./session-url.ts";
import { reloadIfUnauthorized, reloadOnExpiredLogin } from "./auth-expiry.ts";
import { promoteNewSession } from "./session-order.ts";
import { newId } from "./lib/uid.ts";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

/**
 * 每个**标签页**自己的标识（ADR-0033）。
 *
 * 不能用 cookie：cookie 是同浏览器所有标签页共享的，A 切会话 B 会跟着变。
 * sessionStorage 天然是「每个标签页一份」，刷新保留、新标签页新值。
 */
const CLIENT_KEY = "agent-web-client";
function clientId(): string {
	let value = sessionStorage.getItem(CLIENT_KEY);
	if (!value) {
		value = newId();
		sessionStorage.setItem(CLIENT_KEY, value);
	}
	return value;
}

let source: EventSource | null = null;
let attempt = 0;
let seq = 0;

/**
 * 请求失败之后的**状态对帐**（退避重试的轮数 + 已经排上的定时器）。
 *
 * 为什么要有：服务重启（dev 的 `tsx --watch` 一改 server 文件就重启）、反代抖一下时，
 * `POST /api/rpc` 会直接回 502 —— 这一轮的收尾帧（`turn_end` + 最后一帧快照）**永远不会到**。
 * 客户端只留一条红字，界面上就卡在「正在等待模型…」转圈，用户除了手动刷新没有别的出路。
 * 所以失败后主动要一次权威快照：新服务根本没有在跑的回合 → 转圈立刻停。
 */
let resyncAttempt = 0;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;

function resyncAfterFailure(): void {
	if (resyncTimer !== null) return; // 已经在排队了，别叠加
	if (resyncAttempt >= 3) {
		resyncAttempt = 0;
		return;
	}
	const delay = Math.min(BASE_BACKOFF_MS * 2 ** resyncAttempt, MAX_BACKOFF_MS);
	resyncAttempt += 1;
	resyncTimer = setTimeout(() => {
		resyncTimer = null;
		void send({ id: `req-${++seq}`, type: "get_state" });
	}, delay);
}

export function connect(): void {
	if (source && source.readyState !== EventSource.CLOSED) return;

	setAppState({ connection: "connecting" });
	// SSE 带不了自定义头，所以用查询参数把标签页标识带过去；
	// `slim=1` 是客户端能力协商：告诉服务端「快照里可以省掉会话清单（变了再发）」——
	// 那份清单上百 KB，而它几乎不变，每帧都发就是手机上切会话慢的主因。
	const next = new EventSource(`/api/events?client=${encodeURIComponent(clientId())}&slim=1`);
	source = next;

	next.addEventListener("open", () => {
		attempt = 0;
		setAppState({ connection: "open", lastError: null });
		request("get_state");
	});

	next.addEventListener("message", (event) => {
		let parsed: ServerMessage;
		try {
			parsed = JSON.parse(String(event.data)) as ServerMessage;
		} catch {
			return;
		}
		handle(parsed);
	});

	next.addEventListener("error", () => {
		setAppState({ connection: "closed" });
		// EventSource 自己会重连，但间隔由浏览器定（可能很久）；这里再兜一层
		if (next.readyState === EventSource.CLOSED) {
			source = null;
			// 401（登录态过期）时 SSE 不会重连：探一次健康接口，确认过期就整页刷新
			void reloadOnExpiredLogin();
			const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
			attempt += 1;
			setTimeout(connect, delay);
		} else {
			setAppState({ connection: "connecting" });
		}
	});
}

export function request(type: ClientRequestType): string {
	const id = `req-${++seq}`;
	send({ id, type } as ClientRequest);
	return id;
}

/**
 * 发一条 RPC。
 *
 * 返回的 promise 在**服务端回包那一刻** resolve（HTTP 响应里带着同步帧）。
 * 一般请求几十毫秒就回来了；「想想」这类会跑一个隐藏回合的请求要等模型出完结果
 * （最长是设置里的 `thinkTimeoutSec`，默认 20 秒）——按钮就是拿它做「点完先置灰、
 * 回包再亮回来」（见 ThinkButton）。
 * 失败的提示已经在这里统一落到 `lastError`，调用方不用再 catch。
 */
export function send(requestMessage: ClientRequest): Promise<void> {
	return (async () => {
		try {
			const response = await fetch("/api/rpc", {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-client": clientId() },
				body: JSON.stringify(requestMessage),
			});
			if (!response.ok) {
				if (reloadIfUnauthorized(response.status)) return;
				/**
				 * 502 / 503 / 504 几乎都是「后端刚好不在」：开发态 `tsx --watch` 重启的那一两秒，
				 * 或者 `aw restart` 的空窗。此时 Vite / 反向代理连不上后端，回的就是 502
				 * （终端里那行 `http proxy error: connect ECONNREFUSED 127.0.0.1:25258`）。
				 * 这**不是**模型报错，也不是请求本身错了 —— 文案要说清，别让人去查 provider。
				 * 红条会在 SSE 重新连上时自动清掉（见 `connect()` 里的 lastError: null）。
				 */
				const backendDown = response.status === 502 || response.status === 503 || response.status === 504;
				setAppState({
					lastError: {
						text: backendDown
							? `后端正在重启或还没起来（HTTP ${response.status}），稍等自动恢复`
							: `请求失败：HTTP ${response.status}`,
						conversationId: null,
					},
				});
				resyncAfterFailure();
				return;
			}
			resyncAttempt = 0; // 通了就清零：下次再挂还是从 0.5s 起
			const body = (await response.json()) as { frames?: string[] };
			// 同步产生的帧（reply / notice）在这里消费；异步事件走 SSE
			for (const frame of body.frames ?? []) {
				try {
					handle(JSON.parse(frame) as ServerMessage);
				} catch {
					// 单帧坏掉不影响其它帧
				}
			}
		} catch {
			setAppState({ lastError: { text: "连接尚未就绪，稍后再试", conversationId: null } });
			resyncAfterFailure();
		}
	})();
}

/** 取消一条排队消息（真删服务端队列） */
export function cancelQueued(queueId: string): void {
	send({ id: `req-${++seq}`, type: "cancel_queued", payload: { queueId } });
}

/** 停掉一个正在跑 / 在排队的子代理（只停它） */
export function interruptSubagent(runId: string): void {
	send({ id: `req-${++seq}`, type: "interrupt_subagent", payload: { runId } });
}

/** 存一个子代理模板（落 `~/.pi/agent/agents/<id>.md`） */
export function saveSubagentProfile(profile: SubagentProfileView): void {
	send({ id: `req-${++seq}`, type: "save_subagent_profile", payload: { profile } });
}

/** 删一个用户模板（内置只能停用） */
export function deleteSubagentProfile(profileId: string): void {
	send({ id: `req-${++seq}`, type: "delete_subagent_profile", payload: { profileId } });
}

/** 子代理总开关 / 并发上限 */
export function setSubagentSettings(patch: { enabled?: boolean; concurrency?: number }): void {
	send({ id: `req-${++seq}`, type: "set_subagent_settings", payload: patch });
}

/** 拉一次权威快照（服务端会顺带重扫 pi 会话列表） */
export function requestState(): void {
	send({ id: `req-${++seq}`, type: "get_state" });
}

/** 发一条用户消息（可带附件引用；图片本体早就通过 HTTP 上传了） */
export function sendMessage(text: string, attachments?: AttachmentRef[], mode?: SendMode): void {
	send({
		id: `req-${++seq}`,
		type: "send_message",
		payload: {
			text,
			...(attachments && attachments.length > 0 ? { attachments } : {}),
			...(mode && mode !== "now" ? { mode } : {}),
		},
	});
}

export function interrupt(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "interrupt", payload: { conversationId } });
}

/** 新会话界面里待补发的第一条消息（`new_chat` 的 reply 回来时发出去，见 `createSessionAndSend`） */
let pendingAfterNewChat: { text: string; attachments?: AttachmentRef[]; mode?: SendMode } | null = null;
/**
 * 那一次 `new_chat` 的请求 id（reply 只带 id、不带类型，只能自己记下来认它）。
 *
 * **每一次新建都记**，不只是「新会话界面里带第一条消息」那种：项目行上的「+」、斜杠命令
 * `/new`、临时聊天开的会话同样是新建，reply 回来都得把自己的 id 顶到 `order` 表头（`pinNewSessionOnTop`）。
 * 漏一种的后果就是那种会话不在表里，排到手动排序段后面去（列表底部），看着像「建了没出现」。
 */
let newChatRequestId: string | null = null;
/**
 * 那一次 `new_chat` 建的是不是**临时会话**（不落盘、也不进侧栏）——那种不用顶到第一位。
 * 要和 `newChatRequestId` 一起设，因为 reply 回来时只能靠这个记住当时要的是什么。
 */
let newChatEphemeral = false;
/** 派生会话（`fork_session`）的请求 id：派生出来的也是一条新会话，同样要顶到第一 */
let forkRequestId: string | null = null;
/**
 * 已经发出 `new_chat`、但服务端还没把本客户端的视图切过去的那一段。
 *
 * `from` = 发请求时正在看的那条会话：判断「切过去了没有」只能用它（新 id 事先不知道）。
 * 这一段里屏幕既不能退回 `from` 那条会话的正文，也不能把「新会话界面」当成已经结束
 * （见 `store.ts` 的 `pendingNewChat` 与 App.tsx 的 `messages`）。
 */
let newChatInFlight: { from: string | null } | null = null;
/**
 * 临时会话转正（`persist_conversation`）的请求：那一刻它才**第一次出现在侧栏**，
 * 所以也要顶到第一位（reply 里不带会话 id，只能自己记着当时要保存的是哪条）。
 */
let persistRequest: { id: string; conversationId: string } | null = null;

/**
 * 「新会话界面」里发出第一条消息（见 store 的 `newSession`）——到这一刻会话才真的被建出来：
 * **先建会话，建好之后立刻把这条消息发出去**。
 *
 * 为什么不在这里自己发 `send_message`：`send_message` 是发给「本客户端当前那条会话」的，
 * 新会话的 id 要等 `new_chat` 回来才有。所以这里只把正文记在一旁边，等 `new_chat` 的
 * reply 到了再补发（见 `handle()`）—— 那时候服务端已经把本客户端的视图指到新会话上了。
 *
 * 建失败不丢字：正文退回输入框（人不用重打），错误照旧报在下面。
 */
export function createSessionAndSend(
	text: string,
	attachments?: AttachmentRef[],
	mode?: SendMode,
	workspace?: string,
	/** `ephemeral` = 「临时会话（不保存）」：纯内存、不落盘（只有声明了 `ephemeralChat` 的引擎支持） */
	options?: { ephemeral?: boolean },
): void {
	pendingAfterNewChat = { text, attachments, mode };
	newChat(workspace, options);
}

/** 新建会话；传 workspace = 在这个项目下新建（项目行上的「+」） */
export function newChat(workspace?: string, options?: { ephemeral?: boolean }): void {
	// 光标先抢进输入框：必须在点击的**同一个任务**里做，iOS 才会弹键盘
	// （等快照回来再 focus，光标进去了但键盘不出来 —— 手机上像没反应）
	focusComposer();
	// 输入框那一格不用在这里交接：新会话的 id 要等 reply 才知道，
	// 等快照把视图切过去时由 `handle()` 统一交接（见 `handoffDraft` 上方那段注释）。
	//
	// 「新会话界面」（`newSession`）**要留到快照真切过去**才关：
	// 以前这里就 `newSession: null`，于是发出第一条消息的那一刻，渲染层立刻认为
	// 「这是在看好会话了」，而 `snapshot.active` 还是**上一条会话** —— 屏幕先闪一段别人的
	// 对话（用户 2026-10-30：「新会话第一次发文字，屏幕上会闪现一些别的文字，好像串台」），
	// 等 `new_chat` 的快照到了才换成新的。留着它，这一屏在整个往返期间都还是「空对话」。
	// 新会话的 id 由服务端生成，客户端没法先高亮 —— 先给一条「正在新建」的反馈，
	// 快照一到就自动跳到那个会话（服务端会把发起者自己的视图指过去）
	newChatInFlight = { from: getAppState().snapshot?.active.conversationId ?? null };
	const inFlight = newChatInFlight;
	setAppState({ creating: true, pendingNewChat: true });
	// 兜底：建失败 / 服务端一直没推快照，也不能一直转 —— 更不能一直当成「空对话」、
	// 让那块屏幕再也显示不出消息。到点就把这一屏撒了（宁可退回上一条会话，也别锁死）。
	setTimeout(() => {
		setAppState({ creating: false });
		if (newChatInFlight !== inFlight || inFlight === null) return;
		newChatInFlight = null;
		setAppState({
			pendingNewChat: false,
			...(getAppState().newSession ? { newSession: null } : {}),
		});
	}, 8000);
	const payload = {
		...(workspace ? { workspace } : {}),
		...(options?.ephemeral ? { ephemeral: true } : {}),
	};
	const id = `req-${++seq}`;
	// 这一次的 reply 用来认领「刚建出来的那条会话」：带不带第一条消息都要认（见 `pinNewSessionOnTop`）
	newChatRequestId = id;
	newChatEphemeral = options?.ephemeral === true;
	send(
		Object.keys(payload).length > 0 ? { id, type: "new_chat", payload } : ({ id, type: "new_chat" } as ClientRequest),
	);
}

/** 临时会话转正：让服务端把它导出成真正的会话文件（之后才进历史、CLI 才看得见） */
export function persistConversation(conversationId: string): void {
	const id = `req-${++seq}`;
	persistRequest = { id, conversationId };
	send({ id, type: "persist_conversation", payload: { conversationId } });
}

/** 关闭临时对话：内存里的内容直接丢弃（它没有磁盘文件，关掉就真没了） */
export function closeEphemeral(conversationId: string): void {
	send({ id: `req-${++seq}`, type: "close_ephemeral", payload: { conversationId } });
}

/**
 * 从某条消息派生一条新会话（分支），服务端建好后会自动切过去，原会话不变。
 * `messageId` 是界面消息的 id（= 会话 entry id）。
 */
export function forkSession(conversationId: string, messageId: string): void {
	focusComposer();
	setAppState({ creating: true });
	setTimeout(() => setAppState({ creating: false }), 8000);
	const id = `req-${++seq}`;
	// 派生也是「新建」：reply 回来要把它顶到侧栏第一位（见 `pinNewSessionOnTop`）
	forkRequestId = id;
	send({ id, type: "fork_session", payload: { conversationId, messageId } });
}

/**
 * 新建的会话顶到侧栏最上面（用户 2026-10-29：「新建的会话要放在最顶部」「要放在当前项目最顶上才对」）。
 *
 * 做法是往 `sessionPrefs.order` 表头插一条 —— 侧栏的 `rankSessions` 认这个顺序，
 * 于是它在**自己所在项目**里一定是第一条（项目行上的分组规则不变）。
 * 为什么不在渲染层「把最新的排第一」：`order` 是用户手动拖出来的事实，
 * 渲染层再插一条隐式规则，下次拖动的结果就会跟眼睛看到的不一致。
 *
 * 但**别把「排在最上面」全押在这一条写上**：这张表是整表覆盖写的，任何一次拿旧快照的写入
 * （置顶 / 归档 / 批量还原）都可能把它冲掉 —— 实测就是这样，连着建的 3 条会话全不在表里。
 * 真正兜底的是 `rankSessions` 的第 ① 段：没手动排过、又比手动段新的会话本来就排在最前面。
 *
 * 建会话失败 / 临时会话（不进侧栏）都不调这里。
 */
function pinNewSessionOnTop(conversationId: unknown): void {
	if (typeof conversationId !== "string" || conversationId === "") return;
	const prefs = getAppState().snapshot?.settings.sessionPrefs;
	if (!prefs) return; // 快照还没到：没有 order 可写，宁可不排也不造一份假的
	const order = promoteNewSession(prefs.order, conversationId);
	if (!order) return; // 已经在第一位
	// 整表覆盖写（跟侧栏拖动排序同一套）：只改 order，其余偏好原样带过去
	setSettings({ sessionPrefs: { ...prefs, order } });
}

/** 切会话的一次点击兜底：超过这个时间还没看到服务端确认，就补发一次（只补一次） */
const SWITCH_RETRY_MS = 1200;

/** 改会话显示名：交给服务端写进 pi 的会话文件（session_info），本地不再存一份 */
export function renameSession(conversationId: string, title: string): void {
	send({ id: `req-${++seq}`, type: "rename_session", payload: { conversationId, title } });
}

/**
 * 让 AI 根据当前会话内容重新起个名（跑一次一次性问答，结果直接落盘成会话名）。
 *
 * 提示词、清洗、兜底都在服务端 —— 前端只负责「点一下 / 等回包」，
 * 拿回结果只用来看成功没成功（失败原因由服务端 `notice` 推到界面）。
 */
export function suggestSessionTitle(conversationId: string): Promise<boolean> {
	return (async () => {
		try {
			const response = await fetch("/api/rpc", {
				method: "POST",
				headers: { "content-type": "application/json", "x-agent-client": clientId() },
				body: JSON.stringify({
					id: `req-${++seq}`,
					type: "suggest_title",
					payload: { conversationId },
				}),
			});
			if (!response.ok) {
				if (reloadIfUnauthorized(response.status)) return false;
				setAppState({ lastError: { text: `起名失败：HTTP ${response.status}`, conversationId } });
				return false;
			}
			const body = (await response.json()) as { frames?: string[] };
			let ok = false;
			for (const frame of body.frames ?? []) {
				const parsed = JSON.parse(frame) as {
					type?: string;
					result?: { ok?: boolean; error?: { message?: string } };
					payload?: { message?: string };
				};
				// reply 里的 ok 决定成败；notice 带的是服务端写好的可读原因
				if (parsed.type === "reply") ok = parsed.result?.ok === true;
				if (parsed.type === "reply" && parsed.result?.error?.message) {
					setAppState({ lastError: { text: parsed.result.error.message, conversationId } });
				}
				if (parsed.type === "notice" && parsed.payload?.message && !ok) {
					setAppState({ lastError: { text: parsed.payload.message, conversationId } });
				}
			}
			return ok;
		} catch (error) {
			setAppState({
				lastError: { text: `起名失败：${error instanceof Error ? error.message : String(error)}`, conversationId },
			});
			return false;
		}
	})();
}

/** 把会话拖到另一个项目（改 cwd，id 与历史不变） */
export function moveSession(conversationId: string, workspace: string): void {
	send({ id: `req-${++seq}`, type: "move_session", payload: { conversationId, workspace } });
}

export function switchConversation(conversationId: string): void {
	/**
	 * 输入框草稿先交接（用户 2026-10-30：「切会话时原来的输入内容带过来了」）。
	 *
	 * 放在**改 `pendingActive` 之前**：那一刻 `draft` 还是上一条会话在编辑的那份，
	 * 正好能原样存回它自己那一格，再把目标会话的草稿取出来。
	 * 为什么不只靠快照到手后再交接（`handle()` 里还有一道兜底）：服务端一来一回几百毫秒，
	 * 等它回来才换草稿的话，用户点完会先看到「B 的标题 + A 的半句话」—— 那半句话正是要治的 bug。
	 */
	handoffDraft(conversationId);
	// 先乐观高亮：外网往返几百毫秒，点下去没有反馈会以为没点上
	// （顺手关掉「新会话」那一屏：人已经明确要看另一条会话了，没填的东西不再算数）
	setAppState({ pendingActive: conversationId, preview: null, newSession: null });
	// 地址栏先跟上去；服务端快照随后会校正状态。
	if (typeof window !== "undefined") {
		const href = sessionUrlFor(window.location.href, conversationId);
		window.history.replaceState(null, "", href);
	}
	send({ id: `req-${++seq}`, type: "switch_conversation", payload: { conversationId } });
	// 本地缓存：看过的会话先把正文铺上（首屏不等网络），服务端快照到了再覆盖。
	void readCachedMessages(conversationId).then((messages) => {
		// 期间用户可能又点了别的会话，或者快照已经到了
		if (!messages || getAppState().pendingActive !== conversationId) return;
		setAppState({ preview: { conversationId, messages } });
	});
	// 兜底：网络抖一下 / 那一帧请求丢了，不至于要用户再点第二下。
	// 服务端对重复的 switch 是幂等的（已经切过去了就只重推一份快照）。
	setTimeout(() => {
		if (getAppState().pendingActive !== conversationId) return;
		send({ id: `req-${++seq}`, type: "switch_conversation", payload: { conversationId } });
		// 还是没回音就撤掉高亮：宁可回到「请再点一下」，也别让那一行一直亮着而内容没变
		setTimeout(() => {
			if (getAppState().pendingActive === conversationId) setAppState({ pendingActive: null });
		}, SWITCH_RETRY_MS * 3);
	}, SWITCH_RETRY_MS);
}

/** 写本地缓存的节流定时器（流式输出时不至于每帧都写盘） */
let cacheTimer: ReturnType<typeof setTimeout> | null = null;
let cacheTarget: { conversationId: string; messages: UiMessage[] } | null = null;

function scheduleCacheWrite(conversationId: string, messages: UiMessage[]): void {
	cacheTarget = { conversationId, messages };
	if (cacheTimer) return;
	cacheTimer = setTimeout(() => {
		cacheTimer = null;
		const target = cacheTarget;
		cacheTarget = null;
		if (target) void writeCachedMessages(target.conversationId, target.messages);
	}, 3000);
}

/** 改客户端设置（ADR-0020 §P1）：服务端归一化后落盘，并随快照回推 */
/** 切换当前会话的模型（ADR-0020 §P2） */
/** 思考强度（P4）：档位由引擎给 */
export function setThinkingLevel(level: string): void {
	send({ id: `req-${++seq}`, type: "set_thinking_level", payload: { level } });
}

/** 「想一想」：服务端用隐藏回合重新向模型要一批建议（界面上不会多出对话）
 *
 * 返回的 promise 跟 `send` 一样：隐藏回合**真正结束**（回包）才 resolve。
 * 「想想」按钮靠它把置灰态撤掉 —— 不能只看点击，否则点了半天没反应。
 */
export function refreshActions(conversationId?: string, count?: number): Promise<void> {
	return send({
		id: `req-${++seq}`,
		type: "refresh_actions",
		...(conversationId || count
			? { payload: { ...(conversationId ? { conversationId } : {}), ...(count ? { count } : {}) } }
			: {}),
	});
}

/**
 * 切智能体引擎（顶栏切换面板）：服务端零重启换引擎，项目 / 模型 / 能力矩阵跟着变。
 * 回合在飞时服务端会拒绝（`engine.busy`），界面按 lastError 提示即可。
 */
export function setEngine(engine: string): void {
	send({ id: `req-${++seq}`, type: "set_engine", payload: { engine } });
}

/**
 * 审批模式（P4）：本会话放行 / 照旧询问。
 * 必须带上**当前这条会话**：模式是按会话存的，靠服务端猜（全局 activeId）会把选择记到别人头上。
 */
export function setApprovalMode(mode: ApprovalMode, conversationId?: string | null): void {
	send({
		id: `req-${++seq}`,
		type: "set_approval_mode",
		payload: conversationId ? { mode, conversationId } : { mode },
	});
}

export function setModel(modelId: string): void {
	send({ id: `req-${++seq}`, type: "set_model", payload: { modelId } });
}

/** 列出已配置的 provider（ADR-0025）：结果由服务端以提示形式回传 */
export function requestProviders(): void {
	send({ id: `req-${++seq}`, type: "list_providers" });
}

type UpsertProviderPayload = {
	provider: string;
	baseUrl: string;
	api?: string;
	apiKey?: string;
	models: { id: string; name?: string }[];
	headers?: Record<string, string>;
	/** 改名时传原名字 */
	previousProvider?: string;
};

/** 逐模型测试（ADR-0026 C 期）：会发一次真实请求，所以用 HTTP 拿结构化结果 */
export async function testModel(
	provider: string,
	modelId: string,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; message?: string }> {
	try {
		const response = await fetch(
			`/api/providers/${encodeURIComponent(provider)}/models/${encodeURIComponent(modelId)}/test`,
			{ method: "POST" },
		);
		const body = (await response.json()) as {
			ok?: boolean;
			status?: number;
			latencyMs?: number;
			message?: string;
			error?: { message?: string };
		};
		if (!response.ok) return { ok: false, message: body.error?.message ?? `HTTP ${response.status}` };
		return { ok: body.ok === true, status: body.status, latencyMs: body.latencyMs, message: body.message };
	} catch (cause) {
		return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * 模型测速（`POST /api/models/probe`）：让**当前引擎**真跑一个最小回合，量首字延迟与出字速度。
 *
 * 与 `testModel` 的区别：那条是 provider 级 HTTP ping（要工作台自己持有 key，只有 pi 有），
 * 这条走引擎自己（codex 开临时 thread、claude 开临时 session），不读也不改引擎的凭证。
 * 会消耗少量额度 —— 调用方必须给用户一个明确的确认。
 */
export async function probeModel(
	modelId: string,
	signal?: AbortSignal,
): Promise<{
	ok: boolean;
	ttftMs?: number | null;
	totalMs?: number;
	outputTokens?: number;
	tps?: number | null;
	averageTps?: number | null;
	message?: string;
}> {
	try {
		const response = await fetch("/api/models/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ modelId }),
			...(signal ? { signal } : {}),
		});
		const body = (await response.json()) as {
			ok?: boolean;
			ttftMs?: number | null;
			totalMs?: number;
			outputTokens?: number;
			tps?: number | null;
			averageTps?: number | null;
			message?: string;
			error?: { message?: string };
		};
		return {
			ok: body.ok === true,
			ttftMs: body.ttftMs ?? null,
			totalMs: body.totalMs,
			outputTokens: body.outputTokens,
			tps: body.tps ?? null,
			averageTps: body.averageTps ?? null,
			message: body.message ?? body.error?.message ?? (response.ok ? undefined : `HTTP ${response.status}`),
		};
	} catch (cause) {
		return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** 写回单个模型的规格（ADR-0026 A 期）：数值用字符串传，服务端做校验与归一化 */
export function updateModel(provider: string, model: Record<string, unknown>): void {
	send({ id: `req-${++seq}`, type: "update_model", payload: { provider, model } });
}

/** 启用 / 停用 provider，或（传 modelId 时）单个模型；写 pi settings.json 的 enabledModels */
export function setProviderEnabled(provider: string, enabled: boolean, modelId?: string): void {
	send({
		id: `req-${++seq}`,
		type: "set_enabled_models",
		payload: { provider, enabled, ...(modelId ? { modelId } : {}) },
	});
}

/** 从 provider 下移除一个模型（不动凭证） */
export function removeModel(provider: string, modelId: string): void {
	send({ id: `req-${++seq}`, type: "remove_model", payload: { provider, modelId } });
}

/** 删除 provider（B 期）：模型表与凭证一起删；界面负责二次确认 */
export function deleteProvider(provider: string): void {
	send({ id: `req-${++seq}`, type: "delete_provider", provider });
}

/** 保存 provider 配置：apiKey 留空表示不改动已有 key（结果走提示条） */
export function upsertProvider(payload: UpsertProviderPayload): void {
	send({ id: `req-${++seq}`, type: "upsert_provider", payload });
}

export function setSettings(payload: {
	quickPhrases?: string[];
	/** @deprecated 显隐已改本机偏好（`agent-web.composer.quick`）：这里只为老客户端兼容 */
	quickPhrasesEnabled?: boolean;
	/** null = 恢复默认模板库（服务端专门处理这个手势） */
	templates?: PromptTemplate[] | null;
	/** 项目排序 / 置顶 / 别名（ADR-0028） */
	projectPrefs?: ProjectPrefs;
	/** 会话级偏好：置顶 / 重命名 / 归档 */
	sessionPrefs?: SessionPrefs;
	/** 每个项目的默认模型（workspace → `provider/model`）：整表覆盖 */
	defaultModels?: Record<string, string>;
	/** 「想想」一次生成几条建议（1–5） */
	thinkCount?: number;
	/** 「想想」隐藏回合最多等多久（秒，5–180） */
	thinkTimeoutSec?: number;
}): void {
	send({ id: `req-${++seq}`, type: "set_settings", payload });
}

export function approve(requestId: string, decision: "once" | "always" | "deny"): void {
	send({ id: `req-${++seq}`, type: "approve", payload: { requestId, decision } });
}

function handle(message: ServerMessage): void {
	if (message.type === "reply") {
		/**
		 * 新会话界面的第一条消息：`new_chat` 回来了就把它发出去。
		 * 发在这里（而不是快照之后）是因为服务端在建会话那一刻就把本客户端的视图指过去了，
		 * 紧接着的 `send_message` 就落在新会话上；等快照再发要多等一个往返。
		 */
		if (newChatRequestId !== null && message.id === newChatRequestId) {
			const queued = pendingAfterNewChat;
			const promoted = message.ok && !newChatEphemeral;
			newChatRequestId = null;
			newChatEphemeral = false;
			pendingAfterNewChat = null;
			if (message.ok) {
				// 建出来的会话直接顶到侧栏第一位（临时会话不进侧栏，不排）
				if (promoted) pinNewSessionOnTop((message.result as { conversationId?: unknown } | undefined)?.conversationId);
				if (queued) sendMessage(queued.text, queued.attachments, queued.mode);
			} else if (queued) {
				// 建失败：正文退回输入框，别让人辛苦打的一行字跟着错误一起没了
				setDraft(queued.text);
			}
			// 建失败不会有「切过去了」那一帧（见下面 snapshot 里的 `newChatLanded`）：
			// 在这里自己把待建状态撤了。不撤的话 `pendingNewChat` 会一直是 true，
			// 消息区（App.tsx 的 `messages`）就一直当成「空对话」，怎么都不会再显示了。
			if (!message.ok) newChatInFlight = null;
		}
		// 派生（fork）出来的也是一条新会话：同样顶到第一位
		if (forkRequestId !== null && message.id === forkRequestId) {
			forkRequestId = null;
			if (message.ok) pinNewSessionOnTop((message.result as { conversationId?: unknown } | undefined)?.conversationId);
		}
		// 临时会话转正 = 它第一次进侧栏：同样顶到第一位
		if (persistRequest !== null && message.id === persistRequest.id) {
			const { conversationId } = persistRequest;
			persistRequest = null;
			if (message.ok) pinNewSessionOnTop(conversationId);
		}
		if (!message.ok) {
			// 请求被拒：乐观高亮要退回去，否则那个会话会一直亮着、看着像「点了没反应」。
			// 本地缓存铺出来的 preview 也要撤掉：切换失败时服务端不会再来一帧「active=目标」的
			// 快照把它顶掉，留着它就会出现「屏幕/URL 是 B，消息实际发给了 A」。
			// 切换失败 = 界面退回原来那条会话（`pendingActive` 下面就撤）：草稿也跟着退回去，
			// 否则输入框里留的是**目标会话**那一格（刚被换成它的草稿），然后你在原会话里接着写
			if (getAppState().pendingActive !== null) handoffDraft(getAppState().snapshot?.active.conversationId ?? null);
			setAppState({
				// 归到「当时正在看的那个会话」：换会话就不该再显示别人的错
				lastError: {
					text: `${message.error.code}: ${message.error.message}`,
					conversationId: getAppState().snapshot?.active.conversationId ?? null,
				},
				...(getAppState().pendingActive ? { pendingActive: null } : {}),
				...(getAppState().preview ? { preview: null } : {}),
				// 建会话失败：那一屏「新会话」和草稿都留在原地，人可以再按一次发送
				...(getAppState().pendingNewChat ? { pendingNewChat: false } : {}),
			});
		}
		return;
	}

	if (message.event === "snapshot") {
		const pending = getAppState().pendingActive;
		const preview = getAppState().preview;
		const previous = getAppState().snapshot;
		// 服务端可以省掉 pi 会话清单（只有变了才带）：缺了就沿用上一份，不能把侧栏清空。
		const piProjects = message.snapshot.piProjects ?? previous?.piProjects ?? [];
		/**
		 * 这里必须过一道结构共享：服务端每帧都是一整棵新对象，直接盖下去会让
		 * `memo(MessageView)` 与侧栏的 props 比较全部失效 —— 一帧快照 = 所有消息重新渲染 +
		 * 所有 Markdown 重新解析（临时会话的长对话里就是肉眼可见的卡）。
		 */
		const nextSnapshot = shareSnapshot(previous, { ...message.snapshot, piProjects });
		/**
		 * 「刚建的那条会话来了没有」——判据只有一条：**快照里的 active 换了**。
		 *
		 * 不能拿 `creating` 或「快照到了」当判据：上一轮还在流式的话，`new_chat` 回来之前
		 * 就会先来好几帧**旧会话**的快照，那些帧一清掉门，屏幕上就又是别人的对话了（用户 2026-10-30
		 * 报的就是这个「闪一下别的文字」）。
		 */
		const newChatLanded = newChatInFlight !== null && message.snapshot.active.conversationId !== newChatInFlight.from;
		/**
		 * 这段往返期间在「新会话界面」那一屏上发出去的话，屏幕到这里才算走完 —— 关掉它，
		 * 交给刚建好的那条会话。`!== null` 而不是比对象身份：中途换项目 / 换临时会话
		 * 都会换一个 `newSession` 对象（`setNewSessionWorkspace`），比身份会永远比不上，
		 * 那一屏就再也关不掉（比「早关一帧」糟得多）。
		 */
		const closesNewSessionScreen = newChatLanded && getAppState().newSession !== null;
		if (newChatLanded) newChatInFlight = null;
		/**
		 * 草稿跟着「界面真正在看的那条会话」交接 —— 这是除 `switchConversation` 之外的**全部**来源：
		 * 新会话建好（项目行「+」/ 斜杠命令 / 新会话界面发出第一条）、派生出来的分支、
		 * 服务端自己把视图切走（终端 `aw resume` 之类）。那几条路客户端事先不知道新 id，只能等快照。
		 *
		 * 两道门：
		 *   · 有乐观高亮、而快照还不是那条 → 这帧是**旧的**，交给后面那帧，现在切会把草稿来回抖；
		 *   · 屏幕上还是「待建会话」那一格 → 草稿属于那一格，别被旧会话的流式快照拽走（`screenAfter` 见下）。
		 */
		if (!pending || pending === message.snapshot.active.conversationId) {
			// 这一帧之后屏幕上是哪一屏：刚建好的会话（`closesNewSessionScreen`）或原本就没有新会话屏，
			// 才把草稿交给 active 那条；否则人还在「待建会话」那一格，草稿得留在那儿。
			const screenAfter = closesNewSessionScreen ? null : getAppState().newSession;
			if (!screenAfter) handoffDraft(message.snapshot.active.conversationId ?? null);
		}
		setAppState({
			snapshot: nextSnapshot,
			lastError: null,
			creating: false,
			// 新会话真切过来了：那一屏「新会话」到这里才结束（见 `newChat`）
			...(newChatLanded ? { pendingNewChat: false } : {}),
			...(closesNewSessionScreen ? { newSession: null } : {}),
			// 服务端已经切过去了 → 乐观值可以退休
			...(pending && message.snapshot.active.conversationId === pending ? { pendingActive: null } : {}),
			// 权威快照到了 → 缓存副本不用再顶着了
			...(preview && preview.conversationId === message.snapshot.active.conversationId ? { preview: null } : {}),
		});
		// 顺手把这份正文写进本地缓存（节流）：下次点开就能立刻铺上
		const activeConversation = message.snapshot.active.conversationId;
		if (activeConversation) scheduleCacheWrite(activeConversation, message.snapshot.active.messages);
		return;
	}

	if (message.event === "message_delta") {
		applyDelta(message.conversationId, message.messageId, message.text);
	}
}

function applyDelta(conversationId: string, messageId: string, text: string): void {
	const snapshot: Snapshot | null = getAppState().snapshot;
	if (!snapshot || snapshot.active.conversationId !== conversationId) return;
	const messages = snapshot.active.messages.map((message) =>
		message.id === messageId ? appendTextToMessage(message, text) : message,
	);
	setAppState({ snapshot: { ...snapshot, active: { ...snapshot.active, messages } } });
}
