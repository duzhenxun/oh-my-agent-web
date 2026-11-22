/**
 * 画布：agent 把「接下来要做什么」画成的一张图。
 *
 * 内容**不是**会话列表 —— 是 `snapshot.canvas`（服务端按会话存的那份文档，见
 * `server/session/canvas.ts`）：用户说一句「我要做一个签到活动」，agent 调 `canvas` 工具
 * 把这句话拆成节点 + 依赖，右侧这块就长出来了。
 *
 * 这一层只负责「把文档画好、并且让人能在图上动」：
 *   - 平移 / 缩放 / 框选 / 多选拖动 / 吸附对齐（引擎，别轻易动）；
 *   - 节点坐标：**默认用服务端按依赖层级算好的**，用户拖过之后以本机覆盖为准（localStorage）。
 *
 * 三条必须守住的实现约定（改之前先读）：
 *
 *   1. **只有 `.canvas-world` 带 transform**，`transform-origin: 0 0`。
 *      视口固定不动、只负责裁剪和接手势；给视口也加 transform 会让坐标换算多一层。
 *   2. **世界位移 = 屏幕位移 ÷ 缩放**。做拖动时忘了除 `k`，表现就是"放大后卡跑得比鼠标快"。
 *   3. **拖动期间只改 CSS 变量 `--card-dx/--card-dy`，不动 left/top**。
 *      流式输出时快照每 60ms 推一次、React 一直在重渲染；写进 left/top 会被按回去。
 *
 * 手势：空白左键拖 = 平移；**Shift / Alt + 拖 = 框选**；⌘/Ctrl + 滚轮 = 缩放；拖节点 = 移动。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasDoc, CanvasNode } from "../types.ts";
import { useAppState } from "../store.ts";
import { sendMessage } from "../ws.ts";
import { useT } from "../use-language.ts";

/** 节点位置的**本机覆盖**（用户拖过之后以它为准；没拖过就用服务端排好的坐标） */
const OVERRIDE_KEY = "agent-web.canvas.overrides.v1";
const VIEW_KEY = "agent-web.canvas.view.v2";
const MIN_K = 0.2;
const MAX_K = 2.5;
/** 「适应内容」的缩放下限：节点一多，缩到 0.4 以下就是一片看不清的小方块 */
const FIT_MIN_K = 0.5;
/** 与 `panel-tab-dnd.ts` 一致：5px 内算点击，不算拖 */
const DRAG_THRESHOLD = 5;
/** 吸附距离（**屏幕**像素）：缩得越小越难对齐，所以按屏幕算、用的时候再除以缩放 */
const SNAP_PX = 6;
/** 节点的世界宽度：和 CSS 里的 `.canvas-node` 保持一致（算连线端点要用） */
const NODE_WIDTH = 240;

type Pos = { x: number; y: number };
type Overrides = Record<string, Record<string, Pos>>;

function loadOverrides(): Overrides {
	try {
		const raw = localStorage.getItem(OVERRIDE_KEY);
		if (raw === null) return {};
		const value = JSON.parse(raw) as unknown;
		return typeof value === "object" && value !== null ? (value as Overrides) : {};
	} catch {
		return {};
	}
}

function loadView(): { x: number; y: number; k: number } | null {
	try {
		const raw = localStorage.getItem(VIEW_KEY);
		if (raw === null) return null;
		const value = JSON.parse(raw) as { x?: unknown; y?: unknown; k?: unknown } | null;
		if (
			typeof value?.x !== "number" ||
			typeof value.y !== "number" ||
			typeof value.k !== "number" ||
			!Number.isFinite(value.x) ||
			!Number.isFinite(value.y) ||
			!Number.isFinite(value.k)
		) {
			return null;
		}
		return { x: value.x, y: value.y, k: Math.min(MAX_K, Math.max(MIN_K, value.k)) };
	} catch {
		return null;
	}
}

/** 状态 → 色点 / 文案 / 颜色类 */
function statusOf(node: CanvasNode): { tone: string; zh: string; en: string } {
	if (node.status === "doing") return { tone: "doing", zh: "正在做", en: "Doing" };
	if (node.status === "done") return { tone: "done", zh: "已完成", en: "Done" };
	if (node.status === "blocked") return { tone: "blocked", zh: "卡住了", en: "Blocked" };
	return { tone: "todo", zh: "待办", en: "To do" };
}

/**
 * 从一串"被拖动的边"和"静止的边"里挑一个最近的吸附目标。
 * 三条候选边（左 / 中 / 右，或上 / 中 / 下）× 所有静止节点的同类边，取绝对距离最小且在容差内的。
 */
function bestSnap(moving: number[], targets: number[], tolerance: number): { delta: number; at: number } | null {
	let best: { delta: number; at: number } | null = null;
	for (const value of moving) {
		for (const target of targets) {
			const delta = target - value;
			if (Math.abs(delta) > tolerance) continue;
			if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: target };
		}
	}
	return best;
}

export function CanvasView() {
	const t = useT();
	const { snapshot } = useAppState();
	const doc: CanvasDoc | null = snapshot?.canvas ?? null;
	const conversationId = snapshot?.active.conversationId ?? null;

	const viewportRef = useRef<HTMLDivElement | null>(null);
	/** 外层容器（空状态也渲染）：手势必须挂在这里，否则空画布时触摸板捏合会缩放整个网页 */
	const rootRef = useRef<HTMLDivElement | null>(null);
	const worldRef = useRef<HTMLDivElement | null>(null);
	const readoutRef = useRef<HTMLSpanElement | null>(null);
	const marqueeRef = useRef<HTMLDivElement | null>(null);
	const guideXRef = useRef<HTMLDivElement | null>(null);
	const guideYRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef(loadView() ?? { x: 0, y: 0, k: 1 });
	const saveViewTimer = useRef<number | null>(null);
	const scheduleSaveView = useCallback(() => {
		if (saveViewTimer.current !== null) window.clearTimeout(saveViewTimer.current);
		saveViewTimer.current = window.setTimeout(() => {
			saveViewTimer.current = null;
			try {
				localStorage.setItem(VIEW_KEY, JSON.stringify(viewRef.current));
			} catch {
				// 存不进去只是不记得视口
			}
		}, 300);
	}, []);

	const [overrides, setOverrides] = useState<Overrides>(loadOverrides);
	const overridesRef = useRef(overrides);
	useLayoutEffect(() => {
		overridesRef.current = overrides;
	}, [overrides]);

	const [selected, setSelected] = useState<string[]>([]);
	const selectedRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
		selectedRef.current = new Set(selected);
	}, [selected]);

	/** 节点的实际高度（连线端点要用；宽度是固定常量） */
	const [heights, setHeights] = useState<Record<string, number>>({});
	const nodeElsRef = useRef(new Map<string, HTMLElement>());

	/** 节点坐标：本机覆盖优先，否则用服务端算的 */
	const posOf = useCallback(
		(node: CanvasNode): Pos => overrides[conversationId ?? ""]?.[node.id] ?? { x: node.x, y: node.y },
		[overrides, conversationId],
	);

	/**
	 * 快照里节点变了（agent 重画 / 加节点）之后重新量高度。
	 * 依赖 `doc?.rev`：同一个 rev 不重复量；量完把结果写进 state，连线才会跟着更新。
	 */
	const revision = doc?.rev ?? 0;
	useLayoutEffect(() => {
		const next: Record<string, number> = {};
		for (const [id, element] of nodeElsRef.current) next[id] = element.offsetHeight;
		if (Object.keys(next).length === 0) return;
		setHeights((current) => {
			const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([id, h]) => current[id] === h);
			return same ? current : next;
		});
	}, [revision, overrides]);

	/* ── 视口绘制 ─────────────────────────────────────── */
	const paint = useCallback(() => {
		const view = viewRef.current;
		const world = worldRef.current;
		const viewport = viewportRef.current;
		if (!world || !viewport) return;
		world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`;
		const cell = 24 * view.k;
		viewport.style.backgroundSize = `${cell}px ${cell}px`;
		viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
		if (readoutRef.current) {
			readoutRef.current.textContent = `x ${Math.round(view.x)} · y ${Math.round(view.y)} · ${view.k.toFixed(2)}×`;
		}
	}, []);

	useEffect(() => {
		paint();
	}, [paint]);

	const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

	const zoomAt = useCallback(
		(screenX: number, screenY: number, nextK: number) => {
			const view = viewRef.current;
			const k = clampK(nextK);
			const worldX = (screenX - view.x) / view.k;
			const worldY = (screenY - view.y) / view.k;
			view.k = k;
			view.x = screenX - worldX * k;
			view.y = screenY - worldY * k;
			paint();
			scheduleSaveView();
		},
		[paint, scheduleSaveView],
	);

	/* ── 参考线（吸附时显示） ───────────────────────────── */
	const hideGuides = useCallback(() => {
		for (const ref of [guideXRef, guideYRef]) {
			if (ref.current) ref.current.style.display = "none";
		}
	}, []);
	const showGuides = useCallback((atX: number | null, atY: number | null) => {
		const view = viewRef.current;
		if (guideXRef.current) {
			if (atX === null) guideXRef.current.style.display = "none";
			else {
				guideXRef.current.style.display = "block";
				guideXRef.current.style.transform = `translateX(${atX * view.k + view.x}px)`;
			}
		}
		if (guideYRef.current) {
			if (atY === null) guideYRef.current.style.display = "none";
			else {
				guideYRef.current.style.display = "block";
				guideYRef.current.style.transform = `translateY(${atY * view.k + view.y}px)`;
			}
		}
	}, []);

	/* ── 平移 / 空格 ───────────────────────────────────── */
	const panRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
	const hoverRef = useRef(false);

	/* ── 框选 ─────────────────────────────────────────── */
	const marqueeRefState = useRef<{ id: number; sx: number; sy: number; additive: boolean; moved: boolean } | null>(null);

	/* ── 节点拖动（可能多张，带吸附） ─────────────────────── */
	const dragRef = useRef<{
		pointerId: number;
		ids: string[];
		sx: number;
		sy: number;
		origins: Map<string, Pos>;
		moved: boolean;
	} | null>(null);

	const onNodePointerDown = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement).closest("button")) return;
		event.stopPropagation();

		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		let ids: string[];
		if (additive) {
			const next = new Set(selectedRef.current);
			if (next.has(id)) {
				next.delete(id);
				setSelected([...next]);
				return;
			}
			next.add(id);
			setSelected([...next]);
			ids = [...next];
		} else if (selectedRef.current.has(id)) {
			ids = [...selectedRef.current];
		} else {
			setSelected([id]);
			ids = [id];
		}

		const origins = new Map<string, Pos>();
		for (const each of ids) {
			const node = doc?.nodes.find((entry) => entry.id === each);
			if (node) origins.set(each, posOf(node));
		}
		dragRef.current = { pointerId: event.pointerId, ids: [...origins.keys()], sx: event.clientX, sy: event.clientY, origins, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const applyDrag = useCallback(
		(dx: number, dy: number) => {
			const drag = dragRef.current;
			if (drag === null) return;
			const k = viewRef.current.k;
			const tolerance = SNAP_PX / k;

			let minX = Number.POSITIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const [id, origin] of drag.origins) {
				const element = nodeElsRef.current.get(id);
				const height = element?.offsetHeight ?? heights[id] ?? 84;
				minX = Math.min(minX, origin.x);
				minY = Math.min(minY, origin.y);
				maxX = Math.max(maxX, origin.x + NODE_WIDTH);
				maxY = Math.max(maxY, origin.y + height);
			}
			if (!Number.isFinite(minX)) return;

			const targetXs: number[] = [];
			const targetYs: number[] = [];
			for (const node of doc?.nodes ?? []) {
				if (drag.origins.has(node.id)) continue;
				const pos = posOf(node);
				const height = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
				targetXs.push(pos.x, pos.x + NODE_WIDTH / 2, pos.x + NODE_WIDTH);
				targetYs.push(pos.y, pos.y + height / 2, pos.y + height);
			}

			const snapX = bestSnap([minX + dx, (minX + maxX) / 2 + dx, maxX + dx], targetXs, tolerance);
			const snapY = bestSnap([minY + dy, (minY + maxY) / 2 + dy, maxY + dy], targetYs, tolerance);
			const nextDx = dx + (snapX?.delta ?? 0);
			const nextDy = dy + (snapY?.delta ?? 0);

			for (const id of drag.ids) {
				const element = nodeElsRef.current.get(id);
				if (!element) continue;
				element.style.setProperty("--card-dx", `${nextDx}px`);
				element.style.setProperty("--card-dy", `${nextDy}px`);
			}
			showGuides(snapX?.at ?? null, snapY?.at ?? null);
		},
		[doc?.nodes, heights, posOf, showGuides],
	);

	const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (target.closest(".canvas-node, .canvas-bar")) return;
		const wantMarquee = event.shiftKey || event.altKey;
		if (event.button === 1 || (event.button === 0 && !wantMarquee)) {
			panRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
			viewportRef.current?.classList.add("is-panning");
			viewportRef.current?.setPointerCapture(event.pointerId);
			return;
		}
		if (event.button !== 0) return;
		marqueeRefState.current = {
			id: event.pointerId,
			sx: event.clientX,
			sy: event.clientY,
			additive: event.metaKey || event.ctrlKey,
			moved: false,
		};
		viewportRef.current?.setPointerCapture(event.pointerId);
	};

	const onViewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (pan !== null && event.pointerId === pan.id) {
			viewRef.current.x = pan.ox + (event.clientX - pan.sx);
			viewRef.current.y = pan.oy + (event.clientY - pan.sy);
			paint();
			return;
		}

		const drag = dragRef.current;
		if (drag !== null && event.pointerId === drag.pointerId) {
			const screenDx = event.clientX - drag.sx;
			const screenDy = event.clientY - drag.sy;
			if (!drag.moved && Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD) return;
			if (!drag.moved) {
				drag.moved = true;
				for (const id of drag.ids) nodeElsRef.current.get(id)?.classList.add("is-dragging");
			}
			applyDrag(screenDx / viewRef.current.k, screenDy / viewRef.current.k);
			return;
		}

		const marquee = marqueeRefState.current;
		if (marquee !== null && event.pointerId === marquee.id) {
			const viewport = viewportRef.current;
			const box = marqueeRef.current;
			if (!viewport || !box) return;
			const rect = viewport.getBoundingClientRect();
			const x0 = marquee.sx - rect.left;
			const y0 = marquee.sy - rect.top;
			const x1 = event.clientX - rect.left;
			const y1 = event.clientY - rect.top;
			if (!marquee.moved && Math.hypot(x1 - x0, y1 - y0) < DRAG_THRESHOLD) return;
			marquee.moved = true;
			box.style.display = "block";
			box.style.left = `${Math.min(x0, x1)}px`;
			box.style.top = `${Math.min(y0, y1)}px`;
			box.style.width = `${Math.abs(x1 - x0)}px`;
			box.style.height = `${Math.abs(y1 - y0)}px`;
		}
	};

	const commitMarquee = useCallback(
		(additive: boolean) => {
			const viewport = viewportRef.current;
			const box = marqueeRef.current;
			if (!viewport || !box) return;
			const view = viewRef.current;
			const left = Number.parseFloat(box.style.left);
			const top = Number.parseFloat(box.style.top);
			const width = Number.parseFloat(box.style.width);
			const height = Number.parseFloat(box.style.height);
			const worldLeft = (left - view.x) / view.k;
			const worldTop = (top - view.y) / view.k;
			const worldRight = (left + width - view.x) / view.k;
			const worldBottom = (top + height - view.y) / view.k;

			const hits: string[] = [];
			for (const node of doc?.nodes ?? []) {
				const pos = posOf(node);
				const nodeHeight = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
				const overlaps =
					pos.x < worldRight &&
					pos.x + NODE_WIDTH > worldLeft &&
					pos.y < worldBottom &&
					pos.y + nodeHeight > worldTop;
				if (overlaps) hits.push(node.id);
			}
			setSelected((current) => (additive ? [...new Set([...current, ...hits])] : hits));
		},
		[doc?.nodes, heights, posOf],
	);

	const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (pan !== null && event.pointerId === pan.id) {
			panRef.current = null;
			viewportRef.current?.classList.remove("is-panning");
			scheduleSaveView();
		}

		const marquee = marqueeRefState.current;
		if (marquee !== null && event.pointerId === marquee.id) {
			marqueeRefState.current = null;
			// 先提交、再隐藏：反过来会让 commitMarquee 读到 display:none
			if (marquee.moved) commitMarquee(marquee.additive);
			else if (!marquee.additive) setSelected([]);
			if (marqueeRef.current) marqueeRef.current.style.display = "none";
		}

		const drag = dragRef.current;
		if (drag === null || event.pointerId !== drag.pointerId) return;
		dragRef.current = null;
		hideGuides();
		for (const id of drag.ids) nodeElsRef.current.get(id)?.classList.remove("is-dragging");
		if (!drag.moved) {
			for (const id of drag.ids) {
				const element = nodeElsRef.current.get(id);
				element?.style.removeProperty("--card-dx");
				element?.style.removeProperty("--card-dy");
			}
			return;
		}
		// 松手：先读临时位移、清掉，再把新坐标写进本机覆盖（服务端排的坐标不动）
		const deltas = new Map<string, Pos>();
		for (const id of drag.ids) {
			const element = nodeElsRef.current.get(id);
			if (!element) continue;
			deltas.set(id, {
				x: Number.parseFloat(element.style.getPropertyValue("--card-dx")) || 0,
				y: Number.parseFloat(element.style.getPropertyValue("--card-dy")) || 0,
			});
			element.style.removeProperty("--card-dx");
			element.style.removeProperty("--card-dy");
		}
		const key = conversationId ?? "";
		setOverrides((current) => {
			const forConversation = { ...current[key] };
			for (const [id, delta] of deltas) {
				const origin = drag.origins.get(id);
				if (!origin) continue;
				forConversation[id] = { x: origin.x + delta.x, y: origin.y + delta.y };
			}
			const next = { ...current, [key]: forConversation };
			try {
				localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
			} catch {
				// 存不进去只影响"下次还摆在这儿"
			}
			return next;
		});
	};

	/* ── 滚轮 ─────────────────────────────────────────── */
	useEffect(() => {
		// 挂在**外层容器**上：空画布时 `.canvas-viewport` 根本不存在，
		// 手势没挂上 → 触摸板双指捏合会被浏览器当成「缩放网页」（用户报过）。
		const root = rootRef.current;
		if (!root) return;
		const onWheel = (event: WheelEvent) => {
			// 整个画布区域内一律拦住默认行为：不拦的话双指捏合会缩放整个网页
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				// 捏合 / ⌘+滚轮：以光标为锚缩放（触控板捏合同样带 ctrlKey）
				const rect = root.getBoundingClientRect();
				const factor = Math.exp(-event.deltaY * 0.0025);
				zoomAt(event.clientX - rect.left, event.clientY - rect.top, viewRef.current.k * factor);
				return;
			}
			// 没内容时平移无意义，但已经 preventDefault 了，不会再动网页
			if (viewportRef.current === null) return;
			viewRef.current.x -= event.deltaX;
			viewRef.current.y -= event.deltaY;
			paint();
			scheduleSaveView();
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [paint, zoomAt, scheduleSaveView]);

	/**
	 * 键盘缩放：`+` / `=` 放大、`-` 缩小、`0` 回到 100%，**带 ⌘/Ctrl 也归画布**。
	 *
	 * 为什么要连 ⌘ 一起拦：macOS 用户习惯按 ⌘+ / ⌘-，不拦的话浏览器就把**整个网页**
	 * 缩放了（用户 2026-11-23 报的「整个网页会放大缩小」）。
	 * 只在**鼠标在画布上**时生效：这几个键在输入框里是正经字符，全局抢会把人搞疯。
	 * 缩放以视口中心为锚（不是左上角）—— 否则按两下就把内容甩出屏幕了。
	 */
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!hoverRef.current) return;
			const target = event.target as HTMLElement | null;
			if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
			const viewport = viewportRef.current;
			if (!viewport) return;

			const factor =
				event.key === "+" || event.key === "=" ? 1.15 : event.key === "-" || event.key === "_" ? 1 / 1.15 : null;
			if (factor !== null) {
				event.preventDefault();
				zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, viewRef.current.k * factor);
				return;
			}
			if (event.key === "0") {
				event.preventDefault();
				zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [zoomAt]);

	/** 适应内容：把所有节点的包围盒塞进视口 */
	const fit = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
		const nodes = doc?.nodes ?? [];
		if (nodes.length === 0) return;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const node of nodes) {
			const pos = posOf(node);
			const height = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
			minX = Math.min(minX, pos.x);
			minY = Math.min(minY, pos.y);
			maxX = Math.max(maxX, pos.x + NODE_WIDTH);
			maxY = Math.max(maxY, pos.y + height);
		}
		const pad = 40;
		const k = Math.min(
			1,
			Math.max(
				FIT_MIN_K,
				clampK(
					Math.min(
						(viewport.clientWidth - pad * 2) / Math.max(1, maxX - minX),
						(viewport.clientHeight - pad * 2) / Math.max(1, maxY - minY),
					),
				),
			),
		);
		viewRef.current.k = k;
		// 装得下就居中；装不下就靠左上（否则"居中"会把最左边那排推到屏幕外）
		const centeredX = (viewport.clientWidth - (maxX - minX) * k) / 2 - minX * k;
		const centeredY = (viewport.clientHeight - (maxY - minY) * k) / 2 - minY * k;
		viewRef.current.x = Math.max(centeredX, pad - minX * k);
		viewRef.current.y = Math.max(centeredY, pad - minY * k);
		paint();
		scheduleSaveView();
	}, [doc?.nodes, heights, paint, posOf, scheduleSaveView]);

	const reset = useCallback(() => {
		viewRef.current = { x: 0, y: 0, k: 1 };
		paint();
		scheduleSaveView();
	}, [paint, scheduleSaveView]);

	/**
	 * 画布第一次拿到内容时自动适应一次。
	 * 记录已经适配过的 rev，避免之后 agent 每次加节点都把用户的视角拽走。
	 */
	const fittedRevRef = useRef<number | null>(null);
	useEffect(() => {
		if (revision === 0) return;
		if (fittedRevRef.current !== null) return;
		const frame = window.requestAnimationFrame(() => {
			fittedRevRef.current = revision;
			fit();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [revision, fit]);

	/** 双击节点：让 agent 开始做这件事（往当前会话发一句话） */
	const startNode = useCallback((node: CanvasNode) => {
		const detail = node.detail ? `（${node.detail}）` : "";
		sendMessage(`开始做这一步：${node.title}${detail}`);
	}, []);

	const nodes = doc?.nodes ?? [];
	const chosen = useMemo(() => new Set(selected), [selected]);

	/** 连线：从源节点右边中点到目标节点左边中点的一条曲线 */
	const edges = useMemo(() => {
		if (doc === null || doc.edges.length === 0) return [];
		const posById = new Map(doc.nodes.map((node) => [node.id, posOf(node)]));
		const heightById = new Map(doc.nodes.map((node) => [node.id, heights[node.id] ?? 84]));
		return doc.edges
			.map((edge) => {
				const from = posById.get(edge.from);
				const to = posById.get(edge.to);
				if (!from || !to) return null;
				const x1 = from.x + NODE_WIDTH;
				const y1 = from.y + (heightById.get(edge.from) ?? 84) / 2;
				const x2 = to.x;
				const y2 = to.y + (heightById.get(edge.to) ?? 84) / 2;
				// 目标在左边时（用户可能把节点拖乱了）从源节点左侧出，别画一条横穿整张图的线
				const backwards = x2 < x1;
				const sx = backwards ? from.x : x1;
				const ex = backwards ? to.x + NODE_WIDTH : x2;
				const bend = Math.max(48, Math.abs(ex - sx) * 0.45) * (backwards ? -1 : 1);
				const d = `M ${sx} ${y1} C ${sx + bend} ${y1}, ${ex - bend} ${y2}, ${ex} ${y2}`;
				return { key: `${edge.from}->${edge.to}`, d, label: edge.label, mid: { x: (sx + ex) / 2, y: (y1 + y2) / 2 } };
			})
			.filter((edge): edge is { key: string; d: string; label: string | undefined; mid: Pos } => edge !== null);
	}, [doc, heights, posOf]);

	/* 空状态：还没有画布 */
	if (doc === null || nodes.length === 0) {
		return (
			<div
				className="canvas-view canvas-empty"
				ref={rootRef}
				onPointerEnter={() => {
					hoverRef.current = true;
				}}
				onPointerLeave={() => {
					hoverRef.current = false;
				}}
			>
				<div className="canvas-empty-card">
					<div className="canvas-empty-title">{t("画布还空着", "The canvas is empty")}</div>
					<div className="canvas-empty-body">
						{t(
							"在左边对话里说一句你要做什么，比如「我要做一个签到活动，帮我把要做的事画出来」，agent 会把它拆成一张图放到这里。",
							"Tell the agent what you want to build (e.g. “I'm shipping a check-in campaign — map out what needs to happen”), and it will lay the work out here.",
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="canvas-view" ref={rootRef}>
			<div
				className="canvas-viewport"
				ref={viewportRef}
				onPointerDown={onViewportPointerDown}
				onPointerMove={onViewportPointerMove}
				onPointerUp={endPointer}
				onPointerCancel={endPointer}
				onPointerEnter={() => {
					hoverRef.current = true;
				}}
				onPointerLeave={() => {
					hoverRef.current = false;
					viewportRef.current?.classList.remove("can-pan");
				}}
			>
				<div className="canvas-world" ref={worldRef}>
					{/* 连线画在世界坐标系里，跟着一起缩放 */}
					{edges.length > 0 ? (
						<svg className="canvas-edges">
							{edges.map((edge) => (
								<path key={edge.key} d={edge.d} />
							))}
						</svg>
					) : null}
					{nodes.map((node) => {
						const pos = posOf(node);
						const state = statusOf(node);
						const isSelected = chosen.has(node.id);
						return (
							<div
								className={`canvas-node is-${state.tone}${isSelected ? " is-selected" : ""}`}
								key={node.id}
								ref={(element) => {
									if (element) nodeElsRef.current.set(node.id, element);
									else nodeElsRef.current.delete(node.id);
								}}
								style={{ left: pos.x, top: pos.y }}
								onPointerDown={(event) => onNodePointerDown(event, node.id)}
								onDoubleClick={() => startNode(node)}
								title={t("双击让 agent 开始做这一步", "Double-click to have the agent start this step")}
							>
								<div className="canvas-node-head">
									<span className={`canvas-dot is-${state.tone}`} />
									<span className="canvas-node-title">{node.title}</span>
								</div>
								{node.detail ? <div className="canvas-node-detail">{node.detail}</div> : null}
								<div className={`canvas-node-state is-${state.tone}`}>{t(state.zh, state.en)}</div>
							</div>
						);
					})}
				</div>
				<div className="canvas-marquee" ref={marqueeRef} />
				<div className="canvas-guide canvas-guide-x" ref={guideXRef} />
				<div className="canvas-guide canvas-guide-y" ref={guideYRef} />
			</div>
			<div className="canvas-bar">
				<button type="button" onClick={fit}>
					{t("适应内容", "Fit")}
				</button>
				<button type="button" onClick={reset}>
					{t("重置", "Reset")}
				</button>
				<span ref={readoutRef} />
				<span>
					{nodes.length} {t("个节点", "steps")}
				</span>
				{selected.length > 0 ? (
					<>
						<span className="canvas-bar-sel">{t(`已选 ${selected.length}`, `${selected.length} selected`)}</span>
						<button type="button" onClick={() => setSelected([])}>
							{t("取消选择", "Clear")}
						</button>
					</>
				) : null}
			</div>
			{doc.goal ? <div className="canvas-goal">{doc.goal}</div> : null}
			<div className="canvas-hint">
				{t(
					"拖空白平移 · Shift+拖框选 · 滚轮/键盘 +/- 缩放 · ⌘+滚轮缩放 · 双击节点开工",
					"Drag to pan · Shift+drag to box-select · wheel or +/- to zoom · ⌘+wheel to zoom · double-click to start",
				)}
			</div>
		</div>
	);
}
