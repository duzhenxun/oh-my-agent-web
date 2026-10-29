/**
 * 内容搜索浮层的尺寸（纯函数）。
 *
 * 以前这颗浮层是**写死的** `min(720px, 100%)`：路径那一列（当时限了 `max-width: 45%` 并掐中间）
 * 老被压成 `…26-10-26T14-58-46-214Z.yml:64`，一屏里十几条都是同一串省略号，等于没写路径。
 * 现在：
 *   - 路径列**整条显示、不再截断**（用户要求：以当前项目为根目录往后展示全），放不下才折行；
 *   - 默认宽一截（720 → 920），大部分工作区路径能整条排在一行里；
 *   - 右下角加了抓手，可以拖着调大小，尺寸存 localStorage，下次打开还是那个大小。
 *
 * 与侧栏（`sidebar-layout.ts`）同一套纪律：纯函数算夹取、`agent-web.` 前缀、坏值回默认。
 */

/** 再窄就只剩一条省略号了 */
const SEARCH_MIN_WIDTH = 420;
/** 再矮连「一行关键字 + 一条结果 + 脚注」都放不下 */
const SEARCH_MIN_HEIGHT = 240;
/** 默认宽度：原来的 720px 换成 920px（用户要求「默认的话再宽一些」） */
const SEARCH_DEFAULT_WIDTH = 920;

export const SEARCH_SIZE_KEY = "agent-web.contentSearch.size";

export type SearchSize = { w: number; h: number };

/** 浮层外面那圈留白（`content-search-backdrop` 的 padding + 上下边距），夹取时要让出来 */
const EDGE_PADDING = 32;
const TOP_PADDING = 96;

/**
 * 弹层是**水平居中**的：宽度一变，左右两边各分一半。
 * 拖着右下角往右挪 `dx`，面板宽度得加 `2·dx` —— 右边缘才会正好跟着指针走
 * （左边同时往左长，看着就是「以中线为轴变宽」，这是居中浮层唯一不别扭的画法）。
 * 高度是从上往下长的（贴顶对齐），所以只要 `dy`。
 */
export function growSearchSize(
	start: SearchSize,
	dx: number,
	dy: number,
	viewport: { width: number; height: number },
): SearchSize {
	return clampSearchSize({ w: start.w + dx * 2, h: start.h + dy }, viewport);
}

/** 夹到「放得下 + 看得清」之间，并取整（半像素会让结果列表抖） */
export function clampSearchSize(size: SearchSize, viewport: { width: number; height: number }): SearchSize {
	const maxW = Math.max(SEARCH_MIN_WIDTH, viewport.width - EDGE_PADDING);
	const maxH = Math.max(SEARCH_MIN_HEIGHT, viewport.height - TOP_PADDING - EDGE_PADDING / 2);
	const w = Number.isFinite(size.w) ? size.w : SEARCH_DEFAULT_WIDTH;
	const h = Number.isFinite(size.h) ? size.h : maxH;
	return {
		w: Math.round(Math.min(Math.max(w, SEARCH_MIN_WIDTH), maxW)),
		h: Math.round(Math.min(Math.max(h, SEARCH_MIN_HEIGHT), maxH)),
	};
}

/**
 * 从 localStorage 读尺寸：没有记录 / 记录坏了都回 `null`（null = 用 CSS 默认尺寸，
 * 这样「双击抓手复位」也就是把记录清掉，不必再抄一份默认值）。
 */
export function parseStoredSearchSize(raw: string | null): SearchSize | null {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as { w?: unknown; h?: unknown };
		const w = Number(value?.w);
		const h = Number(value?.h);
		if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
		return { w, h };
	} catch {
		return null;
	}
}
