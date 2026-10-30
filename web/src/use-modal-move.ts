/**
 * 「大弹窗」可以用鼠标**拖动位置**（模型 / 技能 / 设置等面板共用）。
 *
 * 为什么要它：这些面板默认铺满整个视口 —— 想看被挡住的对话（"我刚发的那句在哪"），
 * 以前只能先关掉面板。能推开来对照着看，才谈得上"面板"而不是"跳转"。
 *
 * 实现方式：弹窗在 `.modal-backdrop`（flex 居中）里，所以只要给它
 * `transform: translate(x, y)` 就能移动 —— 不去算 left/top，那套在窗口 resize 后全会乱。
 *
 * 边界：分两档（这是「不要弹到浏览器外面去」那条要求的分水岭）：
 *   - **开面板 / 窗口缩放 / 拖角调尺寸**：严格 —— 整块面板必须在视口内。
 *     存下来的位置可能来自更大的窗口、上一次窗口被拉小、或是旧版本宽松规则留下的，
 *     一打开就跑到屏幕外半边，看着就像坏了；这里自己识别并拉回来。
 *   - **手指正拖着**：宽松 —— 每个方向至少留 MIN_VISIBLE，「推开来对照着看被挡住的对话」
 *     才成立（面板本来铺满，严格夹等于不能动）。松手后存的就是那一刻的值，下次打开按严格夹。
 *
 * 收起/再打开：位置存 localStorage（与尺寸同一套纪律：纯界面偏好，不进快照）；
 * 窗口变小后自动夹回合法范围，免得上一次的位置把面板留在屏幕外。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { currentMobileShell } from "./mobile-shell-dom.ts";

const MODAL_POS_KEY = "agent-web:big-modal-pos:v1";
/** 每个方向至少要留在视口内的宽度（推得再远也还能抓到它） */
export const MIN_VISIBLE = 140;
/** 超过这个位移才算「拖动」而不是「点击」（否则点 tab 会被当成拖拽） */
const DRAG_THRESHOLD = 4;

type ModalPos = { x: number; y: number };
type Box = { width: number; height: number };

const viewport = (): Box => ({ width: window.innerWidth, height: window.innerHeight });
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * 纯函数：把一个轴上的位移夹到合法范围。
 *
 * `strict` = 整块放得下就整块留在视口内（左边缘 0 ~ 视口 - 面板）；
 * 否则（面板比视口还大，只有视口窄到极致时才可能）退化成一至少留 MIN_VISIBLE。
 */
function clampAxis(value: number, sizeLen: number, viewLen: number, strict: boolean): number {
	const centered = (viewLen - sizeLen) / 2;
	const next =
		strict && sizeLen <= viewLen
			? clamp(value, -centered, viewLen - sizeLen - centered)
			: clamp(value, MIN_VISIBLE - sizeLen - centered, viewLen - MIN_VISIBLE - centered);
	// `+ 0` 把 `-0` 拉回 `0`：夹到 0 时 Math.min 会留下负零，写进 transform 看不出区别，但单测里很丑
	return next + 0;
}

/**
 * 纯函数（严格）：整块面板留在视口内。
 *
 * 用在「不是用户此刻拖出来的」那些时机：首次打开、窗口尺寸变了、拖角改大小。
 * 那条「上次关掉时推到右边」的位置一打开就在屏外 —— 自己拉回来，不用人去追。
 */
export function clampModalPos(pos: ModalPos, size: Box, view: Box): ModalPos {
	return {
		x: clampAxis(pos.x, size.width, view.width, true),
		y: clampAxis(pos.y, size.height, view.height, true),
	};
}

/**
 * 纯函数（宽松）：拖动时每个方向至少留 MIN_VISIBLE 在视口内。
 *
 * 只给「手指正按在头部拖」用：要的就是把铺满的面板推开一条缝看后面的对话，
 * 所以这里允许它越出视口；推得再远也还能抓到它。
 */
export function clampModalPosWhileDragging(pos: ModalPos, size: Box, view: Box): ModalPos {
	return {
		x: clampAxis(pos.x, size.width, view.width, false),
		y: clampAxis(pos.y, size.height, view.height, false),
	};
}

/** 纯函数：读存下来的位移（坏值 → 归零，不抛） */
export function readStoredModalPos(raw: string | null): ModalPos {
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
	/**
	 * 重新按严格规则夹一次。**开面板时调**：两个钩子挂在侧栏上（不随弹窗卸载），
	 * 所以「关掉再打开」不会重跑初始化 —— 上次拖到越界的那份位置会一直在，
	 * 用户看到的就是「有时一打开就半个在屏幕外」（用户 2026-10-30 的截图）。
	 */
	reclamp: () => void;
	/**
	 * 调尺寸时鎢住「对面的角」（交给 `useModalSize`）：
	 * `beginResize` 在按下手柄时调，**并把手势开始时的位置交回去** —— 拖角要按「这一块现在
	 * 在哪」算视野，不然从右下角往外拖会把面板推出窗口外；`shiftBy` 在每次 pointermove 里
	 * 传累计位移，`commit` 在松手时把新位置落盘（与拖头部同一份存储）。
	 */
	beginResize: () => ModalPos;
	shiftBy: (delta: { x: number; y: number }) => void;
	commitResize: () => void;
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
					// 拖的时候别顺手选中正文；整块换成 grabbing（否则拖到别处又变回箭头）
					document.body.style.userSelect = "none";
					document.documentElement.classList.add("is-modal-moving");
				}
				moveEvent.preventDefault();
				setPos(clampModalPosWhileDragging({ x: from.x + dx, y: from.y + dy }, size, viewport()));
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
				document.documentElement.classList.remove("is-modal-moving");
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

	const reclamp = useCallback(() => {
		const size = options.size;
		if (!size) return;
		const next = clampModalPos(latest.current, size, viewport());
		// 同步 latest：否则下一次拖动会从那个越界的位置起算
		latest.current = next;
		setPos(next);
	}, [options.size]);

	/**
	 * 调尺寸时的位置锚点（见 use-modal-size.ts 的 `ResizeAnchor`）。
	 *
	 * 为什幺不在 useModalSize 里直接改位置：位置归这个钩子管（夹取 / 持久化都在这里），
	 * 两边各改一半会互相打架。这里只暴露「从手势开始时那个位置算，平移多少」。
	 */
	const anchorBase = useRef(pos);
	const beginResize = useCallback(() => {
		anchorBase.current = latest.current;
		return anchorBase.current;
	}, []);
	const shiftBy = useCallback((delta: { x: number; y: number }) => {
		const next = { x: anchorBase.current.x + delta.x, y: anchorBase.current.y + delta.y };
		// 同步 latest：pointerup 可能赶在下一帧渲染之前（松手时靠它落盘）
		latest.current = next;
		setPos(next);
	}, []);
	const commitResize = useCallback(() => {
		try {
			localStorage.setItem(MODAL_POS_KEY, JSON.stringify(latest.current));
		} catch {
			// 存不了就只在本次生效
		}
	}, []);

	return {
		style: mobile ? undefined : { transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)` },
		start,
		reset,
		reclamp,
		beginResize,
		shiftBy,
		commitResize,
	};
}
