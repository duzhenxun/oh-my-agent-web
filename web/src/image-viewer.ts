/**
 * 对话里的图片「点一下弹大图」的全局状态（模块级 store，同 toast.ts 的做法）。
 *
 * 为什么不直接用 `<a target="_blank">`：点开图片就跑到浏览器新标签页，回来还得切窗口；
 * 预览只是「看清楚这张图」，属于**原地的一瞥**，不该把用户带离对话。
 *
 * 这里存「当前要看的那一张」+ 渲染在 `components/ImageViewer.tsx`（App 里挂一次）。
 * 缩放步进 / 下载文件名的推导是纯函数，放在这里不碰渲染。
 */
import { useSyncExternalStore } from "react";

type ViewedImage = {
	/** 已经解析好的可用地址（/api/uploads/… 、/api/files/raw?path=… 或 http(s)） */
	src: string;
	alt: string;
};

let current: ViewedImage | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 打开预览浮层（src 为空时忽略，避免弹出一个空框） */
export function openImageViewer(src: string, alt = ""): void {
	if (!src) return;
	current = { src, alt };
	emit();
}

export function closeImageViewer(): void {
	if (!current) return;
	current = null;
	emit();
}

export function useViewedImage(): ViewedImage | null {
	return useSyncExternalStore(subscribe, () => current);
}

/* ---- 缩放（1 = 适应窗口，放大缩小都相对它） ---- */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
/** 每点一次乘/除它：25% 一档，手感上不会「跳」 */
const ZOOM_STEP = 1.25;

function clampZoom(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 1;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** 纯函数：按方向算下一档缩放（坏值一律当 1，避免 NaN 把图缩没了） */
export function zoomBy(scale: number, direction: "in" | "out"): number {
	const base = clampZoom(scale);
	return clampZoom(direction === "in" ? base * ZOOM_STEP : base / ZOOM_STEP);
}

/**
 * 纯函数：图片在视口里「适应窗口」时的比例（>1 的小图不放大，保持原始尺寸）。
 * 只用来把缩放档位换算成具体像素宽度 —— 真正显示时 CSS 也有一层 max-width/max-height 兜底。
 */
export function fitScaleOf(
	natural: { width: number; height: number },
	viewport: { width: number; height: number },
	ratio = 0.94,
): number {
	if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
	const scale = Math.min((viewport.width * ratio) / natural.width, (viewport.height * ratio) / natural.height);
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	// 不夹到 ZOOM_MIN：很小的视口下「适应窗口」本来就可能小于 25%，夹上去反而溢出
	return scale > 1 ? 1 : scale;
}

/* ---- 下载 ---- */

/** 文件名里不能出现的字符（Windows 最严，其余系统跟着一起洗），控制字符也算 */
const UNSAFE_CHARS = '\\/:*?"<>|';
const MAX_NAME_LEN = 100;

function sanitizeName(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f || UNSAFE_CHARS.includes(ch) ? "_" : ch;
	}
	return out;
}

function safeBaseName(value: string): string {
	let text = value.trim();
	if (text === "") return "";
	if (/^https?:\/\//i.test(text)) {
		try {
			text = new URL(text).pathname;
		} catch {
			return "";
		}
	}
	text = text.split("?")[0]?.split("#")[0] ?? "";
	try {
		text = decodeURIComponent(text);
	} catch {
		// 坏的 % 转义：保留原样，别为了取名把函数搞崩
	}
	const parts = text.split(/[\\/]/);
	const last = sanitizeName(parts.at(-1) ?? "").trim();
	return last.length > MAX_NAME_LEN ? last.slice(0, MAX_NAME_LEN) : last;
}

/**
 * 纯函数：下载时用什么文件名。
 *
 * 顺序：alt（上传时的原始名）→ 服务端路径参数 `?path=…` → URL 自身的 basename。
 * 优先挑**带扩展名**的那个，否则浏览器存下来的是一坨没有后缀的文件，双击都打不开。
 */
export function downloadNameOf(src: string, alt = ""): string {
	const fromPathParam = (() => {
		const match = /[?&]path=([^&#]*)/.exec(src);
		return match?.[1] ?? "";
	})();
	const candidates = [alt, fromPathParam, src].map(safeBaseName).filter((name) => name !== "");
	const withExt = candidates.find((name) => /\.[A-Za-z0-9]{1,8}$/.test(name));
	return withExt ?? candidates[0] ?? "image";
}
