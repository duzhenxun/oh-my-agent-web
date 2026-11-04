/**
 * 「标注」：选中一段文字 → 留一个编号 + 一句可选的评论。
 *
 * 存哪儿：**localStorage，按会话分 key**。理由跟 `ui-prefs.ts` 那批一样 ——
 * 它只影响这台机器上「我在这条对话里划了哪几句」，不参与服务端快照，
 * 也不需要多设备一致（真要同步，那是另一件事，得先进协议）。
 *
 * 会话被删掉之后，键会留在 localStorage 里变成垃圾；这个可以接受：
 * 一条会话通常也就几条标注、几百字节，比为此维护一份全局索引便宜得多。
 *
 * 这里只放**纯数据操作**（读 / 写 / 增 / 删 / 编号），不碰 DOM、不碰 React。
 * DOM 那边（找位置、上高亮）在 `annotation-anchor.ts` 和组件里。
 */
import type { Anchor } from "./annotation-anchor.ts";
import { appendQuote, quoteOf } from "./selection-quote.ts";
import { webSpotLines, webUrlText, type WebSpot } from "./web-note.ts";

type AnnotationBase = {
	id: string;
	/** 可选评论：不写就是空串（只有编号，也算一条标注） */
	comment: string;
	createdAt: number;
	/**
	 * 引文已经被「放进输入框」搬进草稿了。
	 *
	 * 为什么要记这一位：标注在发送时会被自动追加到消息后面（见 `annotationsAsMessage`），
	 * 而「放进输入框」已经把那一段接进草稿了 —— 不记的话同一段会随着消息发两次。
	 */
	quoted?: boolean;
};

/** 标在**对话里的一段文字**上（原有那套）：存文字 + 上下文，重渲染后还能找回来 */
export type MessageAnnotation = AnnotationBase & {
	/**
	 * 省略 = `"message"`。
	 *
	 * 为什么不写成必填：这个字段是加「网页标注」时才有的，而 localStorage 里存着老数据 ——
	 * 让老数据因为缺一位就整条作废，等于用户以前标的全没了。
	 */
	kind?: "message";
	/** 标在哪条消息上（消息 id，不是 DOM id；DOM 那边拼成 `#msg-<id>`） */
	messageId: string;
	/** 那段文字 + 它前后的上下文（见 annotation-anchor.ts） */
	anchor: Anchor;
};

/**
 * 标在**右侧网页的一处**上。
 *
 * 没有 `messageId` / 锚点：那套是「在一段已知文字里按文字找回位置」，网页这边位置本来就由
 * 拾取脚本给了（选择器），而网页也不归我们渲染（它是 iframe 里的另一个文档）。
 */
export type WebAnnotation = AnnotationBase & {
	kind: "web";
	/**
	 * 这一处在页面上的编号（1, 2, 3…）。
	 *
	 * 跟对话里那种标注不同，它**不是列表下标**：列表发完就清空，而页面上的号要一直留着，
	 * 所以号在拾取时就定下来；胶囊里那一行、发出去那段都复用它，三处不会对不上。
	 */
	number: number;
	spot: WebSpot;
};

export type Annotation = MessageAnnotation | WebAnnotation;

/** 判别式：网页标注不参与「正文里画编号」，其余地方要分开处理时都走它 */
export function isWebAnnotation(item: Annotation): item is WebAnnotation {
	return item.kind === "web";
}

/** 一条会话最多留这么多条：再多就不是「划几句」，是拿它当笔记了 */
const MAX_ANNOTATIONS = 200;

const ANNOTATIONS_KEY = (conversationId: string): string => `agent-web.annotations.${conversationId}`;

/** 一条都读不出来时的兜底：调用方不用到处判空 */
const EMPTY: readonly Annotation[] = [];

/**
 * 读出来的一条合法不合法（用户手改 localStorage、旧版本字段缺失都会走到这里）。
 * 不合格的直接丢：**宁可少一条标注，也不要让一条坏数据把整个列表带崩**。
 */
function parseOne(raw: unknown): Annotation | null {
	if (typeof raw !== "object" || raw === null) return null;
	/** 字段一个一个看类型：这些值是从 localStorage 里读回来的，什么形状都可能 */
	const item = raw as {
		id?: unknown;
		kind?: unknown;
		comment?: unknown;
		createdAt?: unknown;
		quoted?: unknown;
		messageId?: unknown;
		anchor?: unknown;
		spot?: unknown;
		number?: unknown;
	};
	if (typeof item.id !== "string" || item.id === "") return null;
	const base = {
		id: item.id,
		comment: typeof item.comment === "string" ? item.comment : "",
		createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
		quoted: item.quoted === true,
	};
	// 网页标注：认 `kind`，位置只要选择器还在就算能用（地址缺了也还标得准）
	if (item.kind === "web") {
		const spot = (typeof item.spot === "object" && item.spot !== null ? item.spot : null) as Partial<WebSpot> | null;
		if (spot === null) return null;
		if (typeof spot.selector !== "string" || spot.selector.trim() === "") return null;
		return {
			...base,
			kind: "web",
			// 老数据没这一位：0 = 「没号」，渲染时退回列表下标
			number: typeof item.number === "number" && Number.isFinite(item.number) ? item.number : 0,
			spot: {
				url: typeof spot.url === "string" ? spot.url : "",
				selector: spot.selector,
				tag: typeof spot.tag === "string" ? spot.tag : "",
				label: typeof spot.label === "string" ? spot.label : "",
				text: typeof spot.text === "string" ? spot.text : "",
			},
		};
	}
	// 不认识的 kind（以后的版本、或者被手改成了别的）不猜，直接丢
	if (item.kind !== undefined && item.kind !== "message") return null;
	if (typeof item.messageId !== "string" || item.messageId === "") return null;
	const anchor = (
		typeof item.anchor === "object" && item.anchor !== null ? item.anchor : null
	) as Partial<Anchor> | null;
	if (anchor === null) return null;
	if (typeof anchor.exact !== "string" || anchor.exact === "") return null;
	return {
		...base,
		messageId: item.messageId,
		anchor: {
			exact: anchor.exact,
			prefix: typeof anchor.prefix === "string" ? anchor.prefix : "",
			suffix: typeof anchor.suffix === "string" ? anchor.suffix : "",
		},
	};
}

/** JSON 串 → 标注列表（坏一条丢一条，不整体作废） */
export function parseAnnotations(raw: string | null): Annotation[] {
	if (raw === null || raw === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const list: Annotation[] = [];
	for (const entry of parsed) {
		const one = parseOne(entry);
		if (one !== null) list.push(one);
	}
	return list.slice(-MAX_ANNOTATIONS);
}

export function readAnnotations(storage: Storage | null, conversationId: string | null): Annotation[] {
	if (storage === null || conversationId === null) return [...EMPTY];
	try {
		return parseAnnotations(storage.getItem(ANNOTATIONS_KEY(conversationId)));
	} catch {
		// 无痕模式 / 配额满：读都读不了就当没有，反正也只是显示用的
		return [...EMPTY];
	}
}

export function writeAnnotations(storage: Storage | null, conversationId: string | null, list: Annotation[]): void {
	if (storage === null || conversationId === null) return;
	try {
		if (list.length === 0) {
			storage.removeItem(ANNOTATIONS_KEY(conversationId));
			return;
		}
		storage.setItem(ANNOTATIONS_KEY(conversationId), JSON.stringify(list.slice(-MAX_ANNOTATIONS)));
	} catch {
		// 写不进去不影响这次「标注」本身，只是刷新之后没了
	}
}

/**
 * 同一处文字在列表里的下标（找不到 -1）。
 *
 * 「同一处」= 同一条消息 + 三个锚点字段全等 —— 上下文也一样才算同一处，
 * 同一句话在消息里出现两次时它们的上下文必然不同。
 */
export function findSameSpot(list: readonly Annotation[], messageId: string, anchor: Anchor): number {
	return list.findIndex(
		(item) =>
			!isWebAnnotation(item) &&
			item.messageId === messageId &&
			item.anchor.exact === anchor.exact &&
			item.anchor.prefix === anchor.prefix &&
			item.anchor.suffix === anchor.suffix,
	);
}

/**
 * 网页上一处在列表里的下标（找不到 -1）。
 *
 * 「同一处」= 同一页 + 同一个选择器：选择器就是拾取脚本给的坐标，
 * 同一页上同一个选择器指的必然是同一个元素。
 */
export function findWebSpot(list: readonly Annotation[], url: string, selector: string): number {
	return list.findIndex((item) => isWebAnnotation(item) && item.spot.url === url && item.spot.selector === selector);
}

/**
 * 加一条。
 *
 * 同一处再标一次 = **改评论**（覆盖那条的 comment），不是叠第二个编号：
 * 编号是用来对位的，同一处挂两个编号只会让人以为标了两个地方。
 * 「同一处」在对话里看 messageId + 三个锚点字段，在网页里看 url + 选择器。
 */
export function addAnnotation(list: Annotation[], next: Annotation): Annotation[] {
	const existing = isWebAnnotation(next)
		? findWebSpot(list, next.spot.url, next.spot.selector)
		: findSameSpot(list, next.messageId, next.anchor);
	if (existing >= 0) {
		const copy = list.slice();
		const previous = list[existing] as Annotation;
		const incoming = next;
		// 网页标注：位置与意见以新的为准，但**号不能换**（页面上一直写着原来那个号）
		copy[existing] =
			isWebAnnotation(previous) && isWebAnnotation(incoming)
				? { ...previous, spot: incoming.spot, comment: incoming.comment }
				: { ...previous, comment: incoming.comment };
		return copy;
	}
	return [...list, next].slice(-MAX_ANNOTATIONS);
}

export function removeAnnotation(list: Annotation[], id: string): Annotation[] {
	return list.filter((item) => item.id !== id);
}

/** 改一条的评论（列表里那行就地写的那个输入框）：找不到就原样返回 */
export function setAnnotationComment(list: readonly Annotation[], id: string, comment: string): Annotation[] {
	return list.map((item) => (item.id === id ? { ...item, comment } : item));
}

/**
 * 标成「引文已经在草稿里」（「放进输入框」之后调）。
 * 发送时这类标注不会再被自动追加一遍，见 `annotationsAsMessage`。
 */
export function markQuoted(list: readonly Annotation[], id: string): Annotation[] {
	return list.map((item) => (item.id === id ? { ...item, quoted: true } : item));
}

/**
 * 一条标注 → 可以直接接进消息的一段（编号 + 位置/引用块 + 可选评论）。
 *
 * 两种标注共用同一套号（界面上「N 条注释」与页面上的徽标是同一个号）：
 *   - 对话里的那一段 → 引用块，号就是列表序号；
 *   - 网页上的一处 → 地址 + 选择器 + 元素，号是它在页面上的编号（不随列表流转变）。
 * 编号写在正文**上一行**（紧贴、不空行）：看上去就是这段的小标题；
 * 中间空一行会被拆成两个段落，模型容易当成两件事。
 * 单发（「放进输入框」）与批量发送共用它，两边的格式就不会跑偏。
 */
export function annotationBlock(item: Annotation, number: number): string {
	const comment = item.comment.trim();
	// 网页标注用它自己在页面上的号：页面上写着 4，发出去的也不能变成 1
	const own = isWebAnnotation(item) && item.number > 0 ? item.number : number;
	const head = isWebAnnotation(item) ? webAnnotationHead(item, own) : `标注 ${own}：\n${quoteOf(item.anchor.exact)}`;
	return comment === "" ? head : `${head}\n\n${comment}`;
}

/** 网页标注的小标题：编号 + 是哪一页（地址太长就截一下，不截会把一行拉得很长） */
function webAnnotationHead(item: WebAnnotation, number: number): string {
	const url = clipUrl(webUrlText(item.spot));
	const title = url === "" ? `标注 ${number}（网页）：` : `标注 ${number}（网页 ${url}）：`;
	return [title, ...webSpotLines(item.spot)].join("\n");
}

/** 地址只留到「读得出是哪一页」：再长就截，正文里不需要完整 URL */
function clipUrl(url: string): string {
	const MAX = 120;
	return url.length > MAX ? `${url.slice(0, MAX)}…` : url;
}

/**
 * 几条标注 → 一条能直接发出去的消息（纯函数）。
 *
 * 为什么要有它：标注攒着就是「待发的内容」—— 一条条点「放进输入框」太慢，
 * 用户想要的是「有标注时回车就把它们发出去」。
 *
 * 每条带「标注 N：」前缀（N = 列表第几条，跟正文里那个编号一致）：
 * 正文里那几个编号模型是看不见的，只在界面上画着；
 * 不给编号，它回答时就只能拿原文猜「你说的第二条是哪句」。
 */
export function annotationsAsMessage(list: readonly Annotation[]): string {
	let out = "";
	for (const [index, item] of list.entries()) {
		// 已经「放进输入框」的那几条：引文就躺在草稿里，再追加一遍就成了同一段发两次
		if (item.quoted === true) continue;
		out = appendQuote(out, annotationBlock(item, index + 1));
	}
	return out.replace(/\s+$/, "");
}

/** 编号：对话里的按列表第几条（1 开始）；网页标注用它自己那个号（页面上徽标写的也是它） */
export function annotationNumber(list: readonly Annotation[], id: string): number {
	const index = list.findIndex((item) => item.id === id);
	if (index < 0) return 0;
	const item = list[index] as Annotation;
	return isWebAnnotation(item) && item.number > 0 ? item.number : index + 1;
}
