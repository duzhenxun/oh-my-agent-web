/**
 * 右侧网页上的**标记落盘**：标过的地方（选择器 + 那句意见 + 编号）记在本机，
 * 关掉浏览器再打开、页面重开，那些编号框还在。
 *
 * 为什么不跟「注释」存在一起：注释是**待发内容**，发一条就清空（见 `annotations.ts`）；
 * 而页面上的标记是「这一页我标过哪几处」的记录 —— 发过、清过的也该留着，
 * 否则同一个位置再标一次又要从 1 号开始。两者生命周期不同，所以分开放。
 *
 * 存在哪儿、怎么裁：
 *   - `localStorage` 一个键装所有页（每处带上自己的 url），不参与服务端快照；
 *   - 编号按**页**算（同一页上 1,2,3,4…），页面之间互不影响；
 *   - 一页最多留 MAX_PER_PAGE 处、总共最多 MAX_PAGES 页，超了先丢最老的页 ——
 *     这是「标记」不是数据库，长到几十页说明该清一清了。
 *
 * 这里只有纯数据操作（读 / 写 / 发号 / 删），不碰 DOM、不碰 React。
 */

export type PageMark = {
	/** 这一页上的第几处（1, 2, 3…）。发出去就固定，不随列表重排 */
	number: number;
	/** 原网址（不是 `/web/p/…` 那串代理地址） */
	url: string;
	/** CSS 选择器：页面重新加载后靠它把框放回去 */
	selector: string;
	/** 我写的「这里要改成什么」，可为空 */
	comment: string;
	/** 排序/裁剪用（不是给人看的） */
	createdAt: number;
};

const KEY = "agent-web.web-marks.v1";

/** 一页最多留多少处 / 一共留多少页 */
const MAX_PER_PAGE = 200;
const MAX_PAGES = 40;

const EMPTY: readonly PageMark[] = [];

function str(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

/** 一条合不合法：位置（url + 选择器）缺了就没法把框放回去，直接丢 */
function parseOne(raw: unknown): PageMark | null {
	if (typeof raw !== "object" || raw === null) return null;
	const item = raw as Record<string, unknown>;
	const url = str(item.url, 2000).trim();
	const selector = str(item.selector, 400).trim();
	if (url === "" || selector === "") return null;
	const number = typeof item.number === "number" && Number.isFinite(item.number) && item.number > 0 ? item.number : 0;
	return {
		number: Math.floor(number),
		url,
		selector,
		comment: str(item.comment, 2000),
		createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
	};
}

/** JSON 串 → 标记列表（坏一条丢一条，不整体作废） */
export function parseWebMarks(raw: string | null): PageMark[] {
	if (raw === null || raw === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const list: PageMark[] = [];
	for (const entry of parsed) {
		const one = parseOne(entry);
		if (one !== null) list.push(one);
	}
	return trimWebMarks(list);
}

export function readWebMarks(storage: Storage | null): PageMark[] {
	if (storage === null) return [...EMPTY];
	try {
		return parseWebMarks(storage.getItem(KEY));
	} catch {
		// 无痕模式 / 配额满：读不出来就当没有（标记还是能标，只是这次不落盘）
		return [...EMPTY];
	}
}

/**
 * 标记变了的通知（同一个标签页内 `storage` 事件不会触发，所以自己派发一个）。
 *
 * 为什么需要：对话框那一侧（`annotations`）删掉一条网页注释时，页面上那个编号框也要跟着没，
 * 而页面面板拿的名单是它自己读的 —— 不通知它就会一直画着已经删掉的框。
 */
export const WEB_MARKS_EVENT = "agent-web:web-marks";

export function onWebMarksChange(callback: () => void): () => void {
	const onStorage = (event: StorageEvent) => {
		if (event.key === KEY) callback();
	};
	window.addEventListener(WEB_MARKS_EVENT, callback);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(WEB_MARKS_EVENT, callback);
		window.removeEventListener("storage", onStorage);
	};
}

export function writeWebMarks(storage: Storage | null, marks: readonly PageMark[]): void {
	if (storage === null) return;
	try {
		const list = trimWebMarks(marks);
		if (list.length === 0) {
			storage.removeItem(KEY);
		} else {
			storage.setItem(KEY, JSON.stringify(list));
		}
	} catch {
		// 写不进去不影响这次标记本身，只是刷新之后没了
	}
	try {
		window.dispatchEvent(new Event(WEB_MARKS_EVENT));
	} catch {
		// 没有 window（测试环境）就算了
	}
}

/** 超过上限时先丢最老的页（整页丢，不把一页拆成半页） */
function trimWebMarks(marks: readonly PageMark[]): PageMark[] {
	const byPage = new Map<string, PageMark[]>();
	for (const mark of marks) {
		const bucket = byPage.get(mark.url);
		if (bucket === undefined) byPage.set(mark.url, [mark]);
		else bucket.push(mark);
	}
	// 页面按「最后一次标记的时间」从新到旧
	const pages = [...byPage.entries()]
		.map(([url, list]) => ({
			url,
			list: list.sort((left, right) => left.number - right.number).slice(-MAX_PER_PAGE),
			last: list.reduce((now, mark) => Math.max(now, mark.createdAt), 0),
		}))
		.sort((left, right) => right.last - left.last)
		.slice(0, MAX_PAGES);
	return pages.flatMap((page) => page.list);
}

/** 某一页上的标记（按编号从小到大），页面里画框就用它 */
export function marksOfPage(marks: readonly PageMark[], url: string): PageMark[] {
	return marks.filter((mark) => mark.url === url).sort((left, right) => left.number - right.number);
}

/** 这一页下一个该用的号：已有最大号 + 1（清空过的页也接着排，不会退回去） */
export function nextNumberFor(marks: readonly PageMark[], url: string): number {
	let max = 0;
	for (const mark of marks) {
		if (mark.url === url && mark.number > max) max = mark.number;
	}
	return max + 1;
}

/**
 * 加一处（或改一处）。
 *
 * 「同一处」= 同一页 + 同一个选择器：选择器就是拾取脚本给的坐标。
 * 同一处再来一次 = 改那句意见，**号不变**（页面上写着几号就还是几号）。
 */
export function addWebMark(
	marks: readonly PageMark[],
	next: { url: string; selector: string; comment: string },
	now = Date.now(),
): PageMark[] {
	const existing = marks.find((mark) => mark.url === next.url && mark.selector === next.selector);
	if (existing !== undefined) {
		return marks.map((mark) => (mark === existing ? { ...mark, comment: next.comment, createdAt: now } : mark));
	}
	const added: PageMark = {
		number: nextNumberFor(marks, next.url),
		url: next.url,
		selector: next.selector,
		comment: next.comment,
		createdAt: now,
	};
	return trimWebMarks([...marks, added]);
}

/**
 * 删掉**一处**（同一页 + 同一选择器）。编号不重排：其余几处还是原来的号，
 * 与「号一经发出就固定」的约定一致（删了 2 号，3 号还是 3 号）。
 *
 * 对话框那一侧删一条网页注释时用它 —— 两边要认的是同一个「处」，所以拿 url + 选择器对齐。
 */
export function removeMarkAt(marks: readonly PageMark[], url: string, selector: string): PageMark[] {
	return marks.filter((mark) => !(mark.url === url && mark.selector === selector));
}

/** 清掉某一页的所有标记（面板上那颗「清空本页」） */
export function removePageMarks(marks: readonly PageMark[], url: string): PageMark[] {
	return marks.filter((mark) => mark.url !== url);
}
