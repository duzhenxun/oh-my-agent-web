/**
 * 「标注」的锚点：**存文字 + 上下文，不存 DOM 节点**。
 *
 * ADR-0048：标注只记「哪条消息里的哪几句话」+ 一句可选评论，不记 DOM `Range`；
 * 显示层在输入区上方折叠成一条「N 条注释」，发送层完全不动（要发给模型时由用户
 * 从列表里挑「放进输入框」）。理由是两边的时间线不一样：位置要能跟着流式重渲染活下来，
 * 而发出去的内容必须由人说清楚，不能自动往草稿里灌。
 *
 * 为什么不存 `Range`：消息每次重渲染 / 流式追加 / 「过程」折叠展开都会让原来的文本节点
 * 被换掉或挪位置，`Range` 一失效，标注就全飘了（或者直接看不见，还不报错）。
 * 这里借的是 TextQuoteSelector 那套老办法：记下选中的原样文字，外加它**前后各一小段**上下文；
 * 回头在同一个 `.msg-body` 的扁平日志里按文字找回位置，用上下文给多个候选打分挑最像的那个。
 *
 * 于是：
 *   - 消息变长、变短、结构被重排 → 只要那几句话还在，标注就还在；
 *   - 那几句话被删了 → 找不到就是找不到（`locateAnchor` 返回 null），上层据此把这条标注标成失效，
 *     **不能**硬贴到别处去。
 *
 * 纯字符串那一段（`captureAnchor` / `locateAnchor`）不碰 DOM，可以直接引；
 * 底下几个 `*Of` 才是真的要浏览器。
 */

export type Anchor = {
	/** 选中的原样文字（两头空白已 trim） */
	exact: string;
	/** 前面最多 CONTEXT_CHARS 个字（用来区分「同一句话在消息里出现好几次」） */
	prefix: string;
	/** 后面最多 CONTEXT_CHARS 个字 */
	suffix: string;
};

/** 上下文取多少：够区分重复句，又不会因为多打一个空格就整条对不上 */
const CONTEXT_CHARS = 24;

/**
 * 选区偏移 → 锚点。
 *
 * 两头空白直接 trim：鼠标拖选常常多带一个换行，带着它反而更难对上
 * （渲染器在段落之间塞的空白节点数量跟结构有关）。
 * 全空白 / 空选区返回 null —— 没有文字的「标注」没有意义。
 */
export function captureAnchor(flat: string, start: number, end: number, context = CONTEXT_CHARS): Anchor | null {
	const from = Math.max(0, Math.min(start, flat.length));
	const to = Math.max(from, Math.min(end, flat.length));
	let begin = from;
	let finish = to;
	// 只按「空白」收边，不动中间的换行：一段多行文字里的换行是内容的一部分
	while (begin < finish && /\s/.test(flat[begin] as string)) begin += 1;
	while (finish > begin && /\s/.test(flat[finish - 1] as string)) finish -= 1;
	if (finish <= begin) return null;
	return {
		exact: flat.slice(begin, finish),
		prefix: begin > 0 ? flat.slice(Math.max(0, begin - context), begin) : "",
		suffix: finish < flat.length ? flat.slice(finish, Math.min(flat.length, finish + context)) : "",
	};
}

/**
 * 锚点 → 扁平文本里的偏移（找不到返回 null）。
 *
 * 同一段文字在一条回复里出现好几次很常见（「已完成」之类），所以**所有候选都打分**：
 * 前面那截上下文对上了几个字、后面那截对上了几个字，加起来最高者胜，同分取最靠前的。
 * 两段上下文都没对上也不拒绝 —— 结构变了以后往往只剩原样文字还能对上，
 * 这时候「贴到第一处」比「什么都不显示」更好，至少人能看出标的是哪句话。
 */
export function locateAnchor(flat: string, anchor: Anchor): { start: number; end: number } | null {
	if (anchor.exact === "") return null;
	let best: { start: number; end: number; score: number } | null = null;
	let at = flat.indexOf(anchor.exact);
	while (at >= 0) {
		const end = at + anchor.exact.length;
		const score = contextScore(flat, at, end, anchor);
		if (best === null || score > best.score) best = { start: at, end, score };
		// 从下一个字符继续找：允许重叠（「aaaa」里找「aaa」两次都算候选）
		at = flat.indexOf(anchor.exact, at + 1);
	}
	return best === null ? null : { start: best.start, end: best.end };
}

/** 上下文对上了几个字：前面那截从**后往前**比、后面那截从**前往后**比，碰到不一样就停 */
function contextScore(flat: string, start: number, end: number, anchor: Anchor): number {
	let head = 0;
	for (let i = 1; i <= anchor.prefix.length && start - i >= 0; i += 1) {
		if (flat[start - i] !== anchor.prefix[anchor.prefix.length - i]) break;
		head += 1;
	}
	let tail = 0;
	for (let i = 0; i < anchor.suffix.length && end + i < flat.length; i += 1) {
		if (flat[end + i] !== anchor.suffix[i]) break;
		tail += 1;
	}
	return head + tail;
}

/* ------------------------------------------------------------------ *
 * 下面这几个要浏览器（`document` / `NodeFilter`）。
 * 只在函数体里碰 DOM，模块加载时什么都不做 —— 引这个文件不会有副作用。
 * ------------------------------------------------------------------ */

/** 子树里所有文本节点（按文档顺序） */
function textNodesOf(root: Node): Text[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
	return nodes;
}

/** 子树的「扁平文本」：所有文本节点的 data 拼起来，就是锚点偏移那把尺子 */
export function flatTextOf(root: Node): string {
	return textNodesOf(root)
		.map((node) => node.data)
		.join("");
}

/** 扁平偏移 → DOM `Range`（越界返回 null） */
export function rangeOf(root: Node, start: number, end: number): Range | null {
	if (end <= start) return null;
	let offset = 0;
	let from: { node: Text; offset: number } | null = null;
	let to: { node: Text; offset: number } | null = null;
	for (const node of textNodesOf(root)) {
		const length = node.data.length;
		if (from === null && start <= offset + length) from = { node, offset: start - offset };
		if (to === null && end <= offset + length) {
			to = { node, offset: end - offset };
			break;
		}
		offset += length;
	}
	if (from === null || to === null) return null;
	const range = document.createRange();
	range.setStart(from.node, Math.max(0, from.offset));
	range.setEnd(to.node, Math.max(0, to.offset));
	return range;
}

/**
 * 选区 → 锚点（根节点必须是那条消息的 `.msg-body`，尺子要跟找回时用的是同一把）。
 *
 * 偏移用「从根开头到选区起点」那段 Range 的字符串长度算：
 * 跟 `flatTextOf` 用的是同一批文本节点，两边天然对齐。
 */
export function anchorOfRange(root: Node, range: Range): Anchor | null {
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
	const toOffset = (node: Node, offset: number): number | null => {
		const span = document.createRange();
		span.selectNodeContents(root);
		try {
			span.setEnd(node, offset);
		} catch {
			return null;
		}
		return span.toString().length;
	};
	const start = toOffset(range.startContainer, range.startOffset);
	const end = toOffset(range.endContainer, range.endOffset);
	if (start === null || end === null) return null;
	return captureAnchor(flatTextOf(root), start, end);
}
