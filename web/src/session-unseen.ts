/**
 * 「跑完了、你还没看」的会话标记（纯客户端，存 localStorage）。
 *
 * 为什么放在客户端而不是快照里：它描述的是**你这台机器看到哪了**，不是会话本身的状态
 * （ADR-0012：快照是「会话事实」，已读/未读是界面记忆）。多开几个浏览器就是各自的记忆，
 * 这也是用户要的：「跑完了但没去看 → 标题一颗小圆点；点了就消失」。
 *
 * 判定只看两件事：`runningByConversation` 的**跳变**（在跑 → 不在跑了），
 * 以及那一刻你是不是正盯着这条会话（当前会话 + 页面可见）。
 * 逻辑本身是纯函数 `nextMarks`。
 */

/** 一条「跑完没看」的记录：会话 id → 跑完那一刻（毫秒）。值是时间戳，用来排序裁剪 */
export type UnseenMarks = Record<string, number>;

/** 最多记多少条：超过就丢最老的（侧栏只显示当前项目的会话，没必要无限攒） */
const MAX_MARKS = 200;

const STORAGE_KEY = "agent-web.unseen-finish";

/** 一帧观测：谁在跑、你正在看哪条、页面可见吗、现在几点 */
export type Frame = {
	/** 这一帧还在跑的会话 id（服务端 `runningByConversation` 里 status !== idle 的那些） */
	running: string[];
	/** 当前选中的会话（`conversationId`） */
	activeId: string | null;
	/** 页面是否可见（切到别的标签页 / 最小化了就不算「在看」） */
	visible: boolean;
	now: number;
};

const isWatching = (frame: Frame, conversationId: string): boolean =>
	frame.visible && frame.activeId === conversationId;

/**
 * 吃一帧观测，算出新的标记表（纯函数，不改入参）。
 *
 * 三条规则，顺序有讲究：
 *  1. 上一帧在跑、这一帧没有了 = 这一轮**刚跑完** → 你不在看它，就画一颗圆点；
 *  2. 这一帧又在跑的，把旧圆点抹掉（重新开跑 = 那条「跑完没看」过期了）；
 *  3. 你正看着的那条会话一律抹掉 —— 「点开它就消失」和「回到标签页自动算看过」都走这一条。
 *
 * `prevRunning` 传上一帧的结果：首帧为空，所以**不会**把「加载时就停在半空」的会话误标成跑完。
 */
function nextMarks(marks: UnseenMarks, prevRunning: string[], frame: Frame): UnseenMarks {
	let next: UnseenMarks | null = null;
	const edit = (): UnseenMarks => {
		next ??= { ...marks };
		return next;
	};

	// 1. 刚跑完的
	for (const id of prevRunning) {
		if (frame.running.includes(id)) continue;
		// 你正看着它跑完的：那叫「看过了」，不用提示
		if (isWatching(frame, id)) continue;
		edit()[id] = frame.now;
	}
	// 2. 又在跑的：旧标记作废
	for (const id of frame.running) {
		if (next?.[id] !== undefined || marks[id] !== undefined) delete edit()[id];
	}
	// 3. 正在看的那条：算看过
	if (frame.activeId !== null && isWatching(frame, frame.activeId)) {
		if (next?.[frame.activeId] !== undefined || marks[frame.activeId] !== undefined) delete edit()[frame.activeId];
	}

	return next ?? marks;
}

/** 两份标记表是不是一样（一样就不通知订阅者，省一次无谓的重渲染） */
function sameMarks(a: UnseenMarks, b: UnseenMarks): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => b[key] === a[key]);
}

/** 只留最新的 `MAX_MARKS` 条（按时间倒序） */
function pruneMarks(marks: UnseenMarks): UnseenMarks {
	const entries = Object.entries(marks).filter(([, at]) => Number.isFinite(at) && at > 0);
	if (entries.length <= MAX_MARKS) return marks;
	entries.sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.slice(0, MAX_MARKS));
}

/** 从 localStorage 读（坏数据 / 老版本结构一律当空，不让一条脏记录把侧栏卡死） */
function readMarks(raw: string | null): UnseenMarks {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const marks: UnseenMarks = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) marks[key] = value;
		}
		return pruneMarks(marks);
	} catch {
		return {};
	}
}

// ---- 客户端那份活的状态（模块级 store + 订阅，跟 store.ts 同一套写法） ----

/** 首次读取：localStorage 可能压根不存在（SSR / 隐私模式 / 测试环境），一律当空 */
function readInitial(): UnseenMarks {
	try {
		if (typeof localStorage === "undefined") return {};
		return readMarks(localStorage.getItem(STORAGE_KEY));
	} catch {
		return {};
	}
}

let marks: UnseenMarks = readInitial();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function persist(next: UnseenMarks): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// 隐私模式 / 配额满：记不住就算了，不影响这一屏的圆点
	}
}

/** 换一份标记表：一样就不动（避免无谓重渲染） */
function setMarks(next: UnseenMarks): void {
	const pruned = pruneMarks(next);
	if (sameMarks(marks, pruned)) return;
	marks = pruned;
	persist(pruned);
	emit();
}

export function getMarks(): UnseenMarks {
	return marks;
}

export function subscribeMarks(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 点开 / 跑起来之后抹掉一条（幂等：本来没有就什么都不做） */
export function clearUnseen(conversationId: string): void {
	if (marks[conversationId] === undefined) return;
	const { [conversationId]: _gone, ...rest } = marks;
	setMarks(rest);
}

/** 一次抹掉一批（点项目行 = 我看到了这个项目底下的东西） */
export function clearUnseenMany(conversationIds: readonly string[]): void {
	if (!conversationIds.some((id) => marks[id] !== undefined)) return;
	const next: UnseenMarks = { ...marks };
	for (const id of conversationIds) delete next[id];
	setMarks(next);
}

/** 喂一帧观测（由 use-unseen-finish 在每次快照 / 可见性变化时调用） */
export function observeFrame(prevRunning: string[], frame: Frame): void {
	setMarks(nextMarks(marks, prevRunning, frame));
}

// 多开几个标签页时，一个页面点掉了圆点，别的页面也跟着消失
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key !== STORAGE_KEY) return;
		const next = readMarks(event.newValue);
		if (sameMarks(marks, next)) return;
		marks = next;
		emit();
	});
}
