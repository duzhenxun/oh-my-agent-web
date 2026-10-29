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

/** 这张图是不是本工作台上传的（`/n/<id>` 是聊天附件，`/api/uploads/<id>` 是历史会话里的那种） */
export function isAppUpload(src: string): boolean {
	return src.startsWith("/n/") || src.startsWith("/api/uploads/");
}
