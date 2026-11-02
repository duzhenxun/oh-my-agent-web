/**
 * 图片「该显示多大」——只解决一件事：**Retina 截图在对话里显得两倍大**。
 *
 * 事故：macOS 的截图是 2x 物理像素（屏幕上 253pt 宽的一块，存成 506px 的 PNG）。
 * `<img>` 按自然像素 1:1 排版，于是同一张图在对话里是「原图的两倍大」，
 * 跟用户当时屏幕上看到的对不上（2026-10-29：\u201c比我原图都大了\u201d）。
 *
 * 规则：按设备像素比折回逻辑点 —— 也就是「跟你截图时看到的差不多大」。
 * 三条保守约束，宁可少缩也不要乱缩：
 *   1. 只在 `dpr > 1` 时缩：1x 屏幕上按自然尺寸就是对的；
 *   2. 只认**我们自己上传/中转**的图（`/n/…`、`/api/uploads/…`）：站外的示意图不知道是按几倍存的，
 *      猜错就是把它弄糊；
 *   3. 只用来**设上限**，永远不放大；并且 dpr 按 2 封顶（3x 手机上再按 3 缩就小得没法看了）。
 */
export function logicalWidthOf(naturalWidth: number, dpr: number, src: string): number | null {
	if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return null;
	if (!Number.isFinite(dpr) || dpr <= 1) return null;
	if (!isAppUpload(src)) return null;
	return Math.round(naturalWidth / Math.min(dpr, 2));
}

/**
 * 图上最终该写进 `style.max-width` 的像素值（三条上限里最小的那条）。
 *
 * 第三条上限是**正文列宽**，2026-11-02 补上：前两条都是「绝对值」（逻辑尺寸 / 用户设的 400px），
 * 手机上的正文列只有 340 上下，400px 的图会把气泡顶出去 —— 图片自己的 `max-width` 是内联的，
 * 权重高于样式表里的 `max-width: 100%`，于是整条消息栏横向撑开、整页能左右拖（“跑版”）。
 * 列宽只在运行时知道（顶栏高度/侧栏开合/字号档位都会变），所以由组件量了传进来。
 *
 * `availableWidth` 为 null / 非正数时视为「量不到」（面板关着、还没布局），照旧只按前两条收。
 */
export function imageMaxWidthOf(input: {
	naturalWidth: number;
	dpr: number;
	src: string;
	/** 用户设的上限（0 / null = 不设） */
	cap: number | null;
	/** 正文列宽（图片所在块级容器的内容宽） */
	availableWidth: number | null;
}): number | null {
	const logical = logicalWidthOf(input.naturalWidth, input.dpr, input.src);
	const limit = input.cap !== null && Number.isFinite(input.cap) && input.cap > 0 ? input.cap : null;
	let width = logical === null ? limit : limit === null ? logical : Math.min(logical, limit);
	const available = input.availableWidth;
	if (available !== null && Number.isFinite(available) && available > 0) {
		const room = Math.floor(available);
		width = width === null ? room : Math.min(width, room);
	}
	return width;
}

/** 这张图是不是本工作台上传的（`/n/<id>` 是聊天附件，`/api/uploads/<id>` 是历史会话里的那种） */
export function isAppUpload(src: string): boolean {
	return src.startsWith("/n/") || src.startsWith("/api/uploads/");
}
