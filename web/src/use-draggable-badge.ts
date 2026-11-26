/**
 * 浮条「拖着走」这一套：pointer capture + 夹进视口 + 记住位置 + 转屏后重新夹。
 *
 * 为什么抽成一个 hook：语音输入按钮（`VoiceInputBadge`）这类浮钮要能拖到任意位置
 * 要的是同一件事，第二遍手抄最容易漏掉的就是「上次在大窗口里拖到角落，换设备后跑到屏幕外」。
 *
 * 约定：
 *   - 没存过位置时返回 `pos === null`，由 CSS 决定默认位（两个浮条的默认位不一样）；
 *   - `onPointerUp` 返回 true 表示「这一下是拖动」，调用方据此跳过 click
 *     —— 圆形按钮既是拖拽把手又是开关，不区分的话一拖就会顺手触发一次开关。
 */
import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
} from "react";
import { readStored, writeStored } from "./ui-prefs.ts";

export type BadgePoint = { x: number; y: number };

/** 拖动与点击的分界：移动不到这么多像素就当「点了一下」（手指抖一下不算拖） */
const DRAG_SLOP_PX = 4;
const DEFAULT_EDGE = 8;

function clampPoint(point: BadgePoint, size: { width: number; height: number }, edge: number): BadgePoint {
	const maxX = Math.max(edge, window.innerWidth - size.width - edge);
	const maxY = Math.max(edge, window.innerHeight - size.height - edge);
	return {
		x: Math.min(Math.max(edge, point.x), maxX),
		y: Math.min(Math.max(edge, point.y), maxY),
	};
}

/** 读上次拖到的位置；坏数据（手改过 localStorage / 旧格式）一律当没存过 */
function readPoint(key: string): BadgePoint | null {
	const raw = readStored(key);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<BadgePoint>;
		if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
		if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
		return { x: parsed.x, y: parsed.y };
	} catch {
		return null;
	}
}

export function useDraggableBadge<T extends HTMLElement>(options: {
	/** 位置存在 localStorage 的这个 key 里 */
	storageKey: string;
	/** 至少留多少像素在视口内（默认 8） */
	edge?: number;
	/** 按在这些元素上不开始拖动（例如浮条里的按钮） */
	ignoreSelector?: string;
	/** 浮条没显示时传 false：省掉 resize 监听 */
	active?: boolean;
}): {
	ref: RefObject<T | null>;
	pos: BadgePoint | null;
	dragging: boolean;
	style: CSSProperties | undefined;
	onPointerDown: (event: ReactPointerEvent<T>) => void;
	onPointerMove: (event: ReactPointerEvent<T>) => void;
	/** 返回 true = 这一下是拖动（调用方据此跳过 click / toggle） */
	onPointerUp: (event: ReactPointerEvent<T>) => boolean;
	onPointerCancel: (event: ReactPointerEvent<T>) => void;
	resetPosition: () => void;
} {
	const edge = options.edge ?? DEFAULT_EDGE;
	const active = options.active ?? true;
	const ref = useRef<T | null>(null);
	const [pos, setPos] = useState<BadgePoint | null>(() => readPoint(options.storageKey));
	const [dragging, setDragging] = useState(false);
	const pointer = useRef<{
		pointerId: number;
		offsetX: number;
		offsetY: number;
		startX: number;
		startY: number;
		moved: boolean;
	} | null>(null);

	const clampIntoView = (): void => {
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		setPos((current) => {
			if (!current) return current;
			const next = clampPoint(current, { width: box.width, height: box.height }, edge);
			return next.x === current.x && next.y === current.y ? current : next;
		});
	};

	// 挂出来时先夹一次：上次在大窗口里拖到的位置，换设备 / 转屏后可能已经在屏幕外
	useEffect(() => {
		if (!active) return;
		clampIntoView();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 只在浮条显出 / 换位置时夹一次
	}, [active, pos === null]);

	// 视口变了（转屏 / 缩窗口）也再夹一次
	useEffect(() => {
		if (!active) return;
		window.addEventListener("resize", clampIntoView);
		return () => window.removeEventListener("resize", clampIntoView);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	const onPointerDown = (event: ReactPointerEvent<T>): void => {
		if (event.button !== 0) return;
		if (options.ignoreSelector && (event.target as HTMLElement).closest(options.ignoreSelector)) return;
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		// 先占住指针：拖得再快也不会丢事件（触屏尤其明显）
		event.currentTarget.setPointerCapture(event.pointerId);
		pointer.current = {
			pointerId: event.pointerId,
			offsetX: event.clientX - box.left,
			offsetY: event.clientY - box.top,
			startX: event.clientX,
			startY: event.clientY,
			moved: false,
		};
		setDragging(true);
	};

	const onPointerMove = (event: ReactPointerEvent<T>): void => {
		const state = pointer.current;
		if (!state || state.pointerId !== event.pointerId) return;
		if (!state.moved) {
			const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
			if (distance < DRAG_SLOP_PX) return;
			state.moved = true;
		}
		const box = ref.current?.getBoundingClientRect();
		setPos(
			clampPoint(
				{ x: event.clientX - state.offsetX, y: event.clientY - state.offsetY },
				{ width: box?.width ?? 0, height: box?.height ?? 0 },
				edge,
			),
		);
	};

	const onPointerUp = (event: ReactPointerEvent<T>): boolean => {
		const state = pointer.current;
		if (!state || state.pointerId !== event.pointerId) return false;
		pointer.current = null;
		setDragging(false);
		if (!state.moved) return false;
		const box = ref.current?.getBoundingClientRect();
		// 存「真正落下的位置」而不是 state：这一拍 state 可能还没渲染进去
		if (box) writeStored(options.storageKey, JSON.stringify({ x: Math.round(box.left), y: Math.round(box.top) }));
		return true;
	};

	const onPointerCancel = (event: ReactPointerEvent<T>): void => {
		const state = pointer.current;
		if (!state || state.pointerId !== event.pointerId) return;
		pointer.current = null;
		setDragging(false);
	};

	const resetPosition = (): void => {
		setPos(null);
		writeStored(options.storageKey, "");
	};

	return {
		ref,
		pos,
		dragging,
		/* 拖过之后用绝对坐标，四边都写死免得互相打架；没拖过就交给 CSS 的默认位 */
		style: pos
			? { left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto", transform: "none" }
			: undefined,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		resetPosition,
	};
}
