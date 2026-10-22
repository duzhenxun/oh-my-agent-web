/**
 * 「大弹窗」可调宽窄 / 高低（模型、技能、推送、设置四个面板共用）。
 *
 * 为什么要自绘手柄：浏览器原生的 `resize` 只在右下角画一个小三角，深色主题下很扎眼，
 * 也没法双击复位、刷新后尺寸也留不住。这里自己挂一只右下角手柄：
 *   - 拖动改宽高（右下角往右/下变大）；
 *   - 双击手柄回到默认尺寸；
 *   - 尺寸存 localStorage（纯界面偏好，不进快照 —— 和侧栏宽度同一套纪律）。
 *
 * 约束：
 *   - 最小 620×340：再小就放不下「左列表 + 右详情」两栏了；
 *   - 最大不超过视口减一圈间距（拖出去就再也抓不回来）；
 *   - 手机壳（单栏）下**不写内联尺寸**：整屏铺满由 CSS 决定，内联会把它顶掉。
 */
import { useCallback, useEffect, useState } from "react";
import { currentMobileShell } from "./mobile-shell-dom.ts";

export const MODAL_SIZE_KEY = "agent-web:big-modal-size";
export const MIN_MODAL_WIDTH = 620;
export const MIN_MODAL_HEIGHT = 340;
/** 默认尺寸：与 CSS 里 `.modal.big-modal` 的 min(1120px, 94vw) / min(760px, 86vh) 同口径 */
const DEFAULT_WIDTH = 1120;
const DEFAULT_HEIGHT = 760;
/** 与 CSS 的 --gap 对齐：四周留一圈，别贴着视口边缘 */
const VIEWPORT_MARGIN = 16;

export type ModalSize = { width: number; height: number };
export type Viewport = { width: number; height: number };

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** 纯函数：当前视口下允许的范围（视口比最小值还小时，最小值优先 —— 宁可溢出也别挤成零宽） */
export function modalSizeBounds(view: Viewport) {
	return {
		minWidth: MIN_MODAL_WIDTH,
		minHeight: MIN_MODAL_HEIGHT,
		maxWidth: Math.max(MIN_MODAL_WIDTH, view.width - VIEWPORT_MARGIN * 2),
		maxHeight: Math.max(MIN_MODAL_HEIGHT, view.height - VIEWPORT_MARGIN * 2),
	};
}

/** 纯函数：默认尺寸（窄屏上自动缩到 94vw / 86vh） */
export function defaultModalSize(view: Viewport): ModalSize {
	const bounds = modalSizeBounds(view);
	return {
		width: Math.round(clamp(Math.min(DEFAULT_WIDTH, view.width * 0.94), bounds.minWidth, bounds.maxWidth)),
		height: Math.round(clamp(Math.min(DEFAULT_HEIGHT, view.height * 0.86), bounds.minHeight, bounds.maxHeight)),
	};
}

/** 纯函数：夹回合法范围（窗口缩小、存了个离谱的值、拖到视口外都走这里） */
export function clampModalSize(size: ModalSize, view: Viewport): ModalSize {
	const bounds = modalSizeBounds(view);
	const width = Number.isFinite(size.width) ? size.width : defaultModalSize(view).width;
	const height = Number.isFinite(size.height) ? size.height : defaultModalSize(view).height;
	return {
		width: Math.round(clamp(width, bounds.minWidth, bounds.maxWidth)),
		height: Math.round(clamp(height, bounds.minHeight, bounds.maxHeight)),
	};
}

/** 纯函数：从 localStorage 读尺寸（没存过 / 坏值 → 默认尺寸） */
export function readStoredModalSize(raw: string | null, view: Viewport): ModalSize {
	if (!raw) return defaultModalSize(view);
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return defaultModalSize(view);
		const record = parsed as { width?: unknown; height?: unknown };
		if (typeof record.width !== "number" || typeof record.height !== "number") return defaultModalSize(view);
		if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return defaultModalSize(view);
		return clampModalSize({ width: record.width, height: record.height }, view);
	} catch {
		return defaultModalSize(view);
	}
}

export function useModalSize() {
	const [size, setSize] = useState<ModalSize>(() =>
		readStoredModalSize(localStorage.getItem(MODAL_SIZE_KEY), viewport()),
	);
	const [mobile, setMobile] = useState(currentMobileShell);

	useEffect(() => {
		localStorage.setItem(MODAL_SIZE_KEY, JSON.stringify(size));
	}, [size]);

	// 窗口变小 / 从双栏切到单栏：尺寸跟着收（否则弹窗会有一半在屏幕外）
	useEffect(() => {
		const onResize = () => {
			setMobile(currentMobileShell());
			setSize((current) => clampModalSize(current, viewport()));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	/** 拖右下角：pointer 事件挂 document（鼠标滑出手柄范围也不会中断） */
	const start = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startY = event.clientY;
			const startSize = size;
			const onMove = (moveEvent: PointerEvent) => {
				setSize(
					clampModalSize(
						{
							width: startSize.width + (moveEvent.clientX - startX),
							height: startSize.height + (moveEvent.clientY - startY),
						},
						viewport(),
					),
				);
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[size],
	);

	const reset = useCallback(() => setSize(defaultModalSize(viewport())), []);

	return {
		size,
		/** 手机壳下留空：整屏铺满交给 CSS */
		style: mobile ? undefined : { width: `${size.width}px`, height: `${size.height}px` },
		start,
		reset,
	};
}
