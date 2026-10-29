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

export type Annotation = {
	id: string;
	/** 标在哪条消息上（消息 id，不是 DOM id；DOM 那边拼成 `#msg-<id>`） */
	messageId: string;
	/** 那段文字 + 它前后的上下文（见 annotation-anchor.ts） */
	anchor: Anchor;
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
	const item = raw as Partial<Annotation>;
	if (typeof item.id !== "string" || item.id === "") return null;
	if (typeof item.messageId !== "string" || item.messageId === "") return null;
	const anchor = item.anchor as Partial<Anchor> | undefined;
	if (typeof anchor !== "object" || anchor === null) return null;
	if (typeof anchor.exact !== "string" || anchor.exact === "") return null;
	return {
		id: item.id,
		messageId: item.messageId,
		anchor: {
			exact: anchor.exact,
			prefix: typeof anchor.prefix === "string" ? anchor.prefix : "",
			suffix: typeof anchor.suffix === "string" ? anchor.suffix : "",
		},
		comment: typeof item.comment === "string" ? item.comment : "",
		createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
		quoted: item.quoted === true,
	};
}

/** JSON 串 → 标注列表（坏一条丢一条，不整体作废） */
function parseAnnotations(raw: string | null): Annotation[] {
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
			item.messageId === messageId &&
			item.anchor.exact === anchor.exact &&
			item.anchor.prefix === anchor.prefix &&
			item.anchor.suffix === anchor.suffix,
	);
}

/**
 * 加一条。
 *
 * 同一处文字再标一次 = **改评论**（覆盖那条的 comment），不是叠第二个编号：
 * 编号是用来在正文里对上位置的，同一句话挂两个编号只会让人以为标了两处。
 * 判断「同一处」用 messageId + 三个锚点字段全等 —— 上下文也一样才算同一处，
 * 同一句话在消息里出现两次时它们的上下文必然不同。
 */
export function addAnnotation(list: Annotation[], next: Annotation): Annotation[] {
	const existing = findSameSpot(list, next.messageId, next.anchor);
	if (existing >= 0) {
		const copy = list.slice();
		copy[existing] = { ...list[existing], comment: next.comment } as Annotation;
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
 * 一条标注 → 可以直接接进消息的一段（编号 + 引用块 + 可选评论）。
 *
 * 编号写在引用块**上一行**（紧贴、不空行）：看上去就是这段引文的小标题；
 * 中间空一行会被拆成两个段落，模型容易当成两件事。
 * 单发（「放进输入框」）与批量发送共用它，两边的格式就不会跑偏。
 */
export function annotationBlock(item: Annotation, number: number): string {
	const quote = quoteOf(item.anchor.exact);
	const comment = item.comment.trim();
	const head = `标注 ${number}：\n${quote}`;
	return comment === "" ? head : `${head}\n\n${comment}`;
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

/** 编号：列表里的第几条（1 开始）；找不到返回 0（调用方据此不画徽标） */
export function annotationNumber(list: readonly Annotation[], id: string): number {
	const index = list.findIndex((item) => item.id === id);
	return index < 0 ? 0 : index + 1;
}
