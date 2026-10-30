/**
 * 面板内的「⌘/Ctrl + `+` / `-` / `0`」缩放（临时聊天、网页、代码预览共用一套手势）。
 *
 * 用户 2026-10-30：「（焦点）点在这里面，Ctrl 加 + 或 - 时，这个里的文字会变大变小，
 * **只会改变他们的、不会改整个网页的**」——也就是把「浏览器页面缩放」收窄成「这一块缩放」。
 *
 * 三个取舍：
 *   1. **挂在 window 的捕获阶段**：面板里的输入框/终端/iframe 各自会吞按键，只有捕获阶段先拦住，
 *      才能保证 `preventDefault()` 抢在浏览器缩放之前；
 *   2. 触发条件与代码预览一致：焦点在这块里，**或者**鼠标正悬在这块上（且焦点没落在别处输入框里）。
 *      否则用户在左边输入框打字时按 Ctrl+=，会把右边面板偷偷放大；
 *   3. 缩放值存 localStorage（`useStoredNumber`，跨标签页同步），
 *      应用方式是给容器写 CSS `zoom` —— 它像页面缩放一样连字号、行高、内边距一起放大，
 *      而且不会撑破父容器（Chrome 里 `zoom` 的元素仍然按父容器算宽度）。
 *
 * 已知边界：焦点落在 **iframe 内部**时，键盘事件根本不会传到父文档（浏览器隔离），
 * 这时只能靠「鼠标悬在面板上 + 焦点还在父页面」来触发 —— 点一下网址栏就能用。
 */
import { useEffect, useRef, useState } from "react";
import { useStoredNumber } from "./use-stored-number.ts";

/** 60% ~ 200%，一档 10%（和浏览器缩放的常见档位同量级） */
const PANEL_ZOOM_MIN = 60;
const PANEL_ZOOM_MAX = 200;
const PANEL_ZOOM_STEP = 10;
const PANEL_ZOOM_DEFAULT = 100;

/** 这个按键组合是不是「放大 / 缩小 / 复位」 */
export function zoomIntent(event: KeyboardEvent): "in" | "out" | "reset" | null {
	if (!event.ctrlKey && !event.metaKey) return null;
	// AltGr 在 Windows 上带 ctrl+alt：别抢人家输入特殊字符的手势
	if (event.altKey) return null;
	if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "in";
	if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "out";
	if (event.key === "0" || event.code === "Numpad0" || event.code === "NumpadInsert") return "reset";
	return null;
}

type PanelZoom = {
	/** 当前缩放（100 = 原样），直接写进 `style.zoom: zoom / 100` 或当百分比用 */
	percent: number;
	/** 挂到**整个面板**的根元素上：既用于判断「焦点/鼠标在不在这块里」 */
	ref: React.RefObject<HTMLDivElement | null>;
	/** 根元素上的指针事件（用来知道鼠标在不在这块上） */
	pointerHandlers: { onPointerEnter: () => void; onPointerLeave: () => void };
};

export function usePanelZoom(storageKey: string): PanelZoom {
	const [percent, setPercent] = useStoredNumber(storageKey, PANEL_ZOOM_DEFAULT, PANEL_ZOOM_MIN, PANEL_ZOOM_MAX);
	const [inside, setInside] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	// setter 每次渲染都是新函数：放进 ref，免得 effect 跟着重挂
	const setPercentRef = useRef(setPercent);
	setPercentRef.current = setPercent;
	const percentRef = useRef(percent);
	percentRef.current = percent;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const host = ref.current;
			if (!host) return;
			const intent = zoomIntent(event);
			if (!intent) return;
			const focusInside = host.contains(document.activeElement);
			if (!focusInside && !inside) return;
			// 焦点在别处的输入框里（例如左边正在打字）就别动这块
			const active = document.activeElement;
			if (!focusInside && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return;
			event.preventDefault();
			event.stopPropagation();
			if (intent === "reset") setPercentRef.current(PANEL_ZOOM_DEFAULT);
			else setPercentRef.current(percentRef.current + (intent === "in" ? PANEL_ZOOM_STEP : -PANEL_ZOOM_STEP));
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [inside]);

	return {
		percent,
		ref,
		pointerHandlers: {
			onPointerEnter: () => setInside(true),
			onPointerLeave: () => setInside(false),
		},
	};
}
