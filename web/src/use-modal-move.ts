/**
 * 「大弹窗」可以用鼠标**拖动位置**（模型 / 技能 / 设置等面板共用）。
 *
 * 为什么要它：这些面板默认铺满整个视口 —— 想看被挡住的对话（"我刚发的那句在哪"），
 * 以前只能先关掉面板。能推开来对照着看，才谈得上"面板"而不是"跳转"。
 *
 * 实现方式：弹窗在 `.modal-backdrop`（flex 居中）里，所以只要给它
 * `transform: translate(x, y)` 就能移动 —— 不去算 left/top，那套在窗口 resize 后全会乱。
 *
 * 边界：不要求整个面板都在视口内（铺满时那等于不能动），而是
 * **每个方向至少留 MIN_VISIBLE 那一块在视口里** —— 推得开，也一定抓得回来。
 *
 * 收起/再打开：位置存 localStorage（与尺寸同一套纪律：纯界面偏好，不进快照）；
 * 窗口变小后自动夹回合法范围，免得上一次的位置把面板留在屏幕外。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { currentMobileShell } from "./mobile-shell-dom.ts";

const MODAL_POS_KEY = "agent-web:big-modal-pos:v1";
/** 每个方向至少要留在视口内的宽度（推得再远也还能抓到它） */
const MIN_VISIBLE = 140;
/** 超过这个位移才算「拖动」而不是「点击」（否则点 tab 会被当成拖拽） */
const DRAG_THRESHOLD = 4;

type ModalPos = { x: number; y: number };
type Box = { width: number; height: number };

const viewport = (): Box => ({ width: window.innerWidth, height: window.innerHeight });
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * 纯函数：把位移夹到「每个方向至少 MIN_VISIBLE 在视口内」。
 *
 * 面板是居中的，未位移时它的左边缘在 `(视口宽 - 面板宽) / 2`；
 * 位移 x 之后左边缘是那个值 + x。要求「右边缘 ≥ MIN_VISIBLE」且「左边缘 ≤ 视口宽 - MIN_VISIBLE」，
 * 解出 x 的上下界。上下同理。
 */
function clampModalPos(pos: ModalPos, size: Box, view: Box): ModalPos {
	const left = (view.width - size.width) / 2;
	const top = (view.height - size.height) / 2;
	const minX = Math.min(0, MIN_VISIBLE - size.width - left);
	const maxX = Math.max(0, view.width - MIN_VISIBLE - left);
	const minY = Math.min(0, MIN_VISIBLE - size.height - top);
	const maxY = Math.max(0, view.height - MIN_VISIBLE - top);
	return { x: clamp(pos.x, minX, maxX), y: clamp(pos.y, minY, maxY) };
}

/** 纯函数：读存下来的位移（坏值 → 归零，不抛） */
function readStoredModalPos(raw: string | null): ModalPos {
	if (!raw) return { x: 0, y: 0 };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { x: 0, y: 0 };
		const record = parsed as Record<string, unknown>;
		const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : 0;
		const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : 0;
		return { x, y };
	} catch {
		return { x: 0, y: 0 };
	}
}

export function useModalMove(options: { size: Box | null }): {
	/** 给 `.modal` 的内联样式（手机上整屏铺满，不位移） */
	style: { transform: string } | undefined;
	/** 挂在**头部**的 pointerdown 上：拖它移动面板 */
	start: (event: React.PointerEvent<HTMLElement>) => void;
	/** 双击头部复位 */
	reset: () => void;
} {
	const [mobile, setMobile] = useState(currentMobileShell);
	const [pos, setPos] = useState<ModalPos>(() => readStoredModalPos(localStorage.getItem(MODAL_POS_KEY)));
	/** 最近一次拖动后的位置：pointerup 里要拿它落盘（state 在同一个回调里读不到最新值） */
	const latest = useRef(pos);
	latest.current = pos;

	// 尺寸或视口变了都可能让「上次的位置」越界：夹回来（面板永远抓得到）
	useEffect(() => {
		const onResize = () => {
			setMobile(currentMobileShell());
			if (!options.size) return;
			setPos((current) => clampModalPos(current, options.size as Box, viewport()));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [options.size]);

	useEffect(() => {
		if (!options.size) return;
		setPos((current) => clampModalPos(current, options.size as Box, viewport()));
	}, [options.size]);

	const start = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (event.button !== 0 || !options.size) return;
			const size = options.size;
			const startX = event.clientX;
			const startY = event.clientY;
			const from = latest.current;
			let dragging = false;

			const onMove = (moveEvent: PointerEvent) => {
				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;
				if (!dragging && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
				if (!dragging) {
					dragging = true;
					// 拖的时候别顺手选中正文
					document.body.style.userSelect = "none";
				}
				moveEvent.preventDefault();
				setPos(clampModalPos({ x: from.x + dx, y: from.y + dy }, size, viewport()));
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
				if (!dragging) return;
				// 拖完松手常会跟一个 click（点在 tab 上就会切面板）：吃掉这一个
				const stopClick = (clickEvent: MouseEvent) => {
					clickEvent.stopPropagation();
					clickEvent.preventDefault();
				};
				document.addEventListener("click", stopClick, { capture: true, once: true });
				// 万一根本没有 click（拖到窗口外松手），半秒后自己摘掉，别把下一次点击吃了
				window.setTimeout(() => document.removeEventListener("click", stopClick, { capture: true }), 400);
				try {
					localStorage.setItem(MODAL_POS_KEY, JSON.stringify(latest.current));
				} catch {
					// 存不了就只在本次生效
				}
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[options.size],
	);

	const reset = useCallback(() => {
		try {
			localStorage.removeItem(MODAL_POS_KEY);
		} catch {
			// 忽略
		}
		setPos({ x: 0, y: 0 });
	}, []);

	return {
		style: mobile ? undefined : { transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)` },
		start,
		reset,
	};
}
