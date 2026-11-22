/**
 * 画布：把会话摊在一个可平移 / 缩放的平面上。
 *
 * 为什么先做这一版（而不是直接上"板子能干活"）：
 * 引擎那一层（平移 / 缩放 / 拖卡）是**所有后续形态的公共底座** —— 驾驶舱、看板、agent 画图
 * 都要长在它上面。所以先把这层做对、做够稳，再往上叠内容。
 *
 * 三条必须守住的实现约定（改之前先读）：
 *
 *   1. **只有 `.canvas-world` 带 transform**，`transform-origin: 0 0`。
 *      视口固定不动、只负责裁剪和接手势；给视口也加 transform 会让坐标换算多一层。
 *   2. **世界位移 = 屏幕位移 ÷ 缩放**。做卡片拖动时忘了除 `k`，表现就是"放大后卡跑得比鼠标快"。
 *   3. **拖动期间只改 CSS 变量 `--card-dx/--card-dy`，不动 left/top**。
 *      这个界面在流式输出时快照每 60ms 推一次、React 一直在重渲染；
 *      要是把位移写进 left/top，下一次重渲染就会把拖动中的位置按回去（闪回）。
 *      CSS 变量不在 React 的 style 管控里，所以安全；松手时才落盘成新坐标。
 *
 * 手势分工（和 Figma / tldraw 一致，别按老习惯改）：
 *   - 空白处左键拖 = **框选**；它原本是平移，现在平移让给下面几种；
 *   - 滚轮 / 触控板双指 = 平移；中键拖、或按住空格拖 = 平移；
 *   - ⌘/Ctrl + 滚轮 = 以光标为锚缩放；
 *   - 拖卡片 = 移动；选中多张时一起移动，并对齐到其他卡片的边（吸附 + 对齐线）。
 *
 * 位置存本机（`localStorage`）：画布是"这台机器上我怎么摆"的偏好，不该进快照、
 * 也不该跟别的设备同步。没摆过的会话按顺序自动排进网格。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.ts";
import { switchConversation } from "../ws.ts";
import { useT } from "../use-language.ts";

const POS_KEY = "agent-web.canvas.pos.v1";
/** 视口（平移量 + 缩放）也存本机：不存的话重新打开会回到原点，拖过的卡片可能在视野外 */
const VIEW_KEY = "agent-web.canvas.view.v1";
/** 一次最多摆这么多张：几百条会话全铺出来既看不清也拖不动 */
const MAX_CARDS = 40;
const GRID_DX = 264;
const GRID_DY = 152;
const GRID_COLS = 4;
/**
 * 网格的起点要避开左上角那个工具条（`top/left: 8px`）。
 * 从 (0,0) 开排的话，第一张卡正好压在工具条下面 —— 点它就是在点工具条，拖不动。
 */
const GRID_ORIGIN_X = 32;
const GRID_ORIGIN_Y = 56;
const MIN_K = 0.2;
const MAX_K = 2.5;
/**
 * 「适应内容」的缩放下限。卡片一多（四十张），按包围盒算出来会到 0.4 以下 ——
 * 整屏都是模糊小方块，看着就像坏了。宁可装不下让人平移，也不缩到看不清。
 */
const FIT_MIN_K = 0.6;
/** 与 `panel-tab-dnd.ts` 一致：5px 内算点击，不算拖 */
const DRAG_THRESHOLD = 5;
/** 吸附距离（**屏幕**像素）：缩得越小越难对齐，所以阈值按屏幕算、用的时候再除以缩放 */
const SNAP_PX = 6;

type Pos = { x: number; y: number };

/** 画布上的一张卡（= 一条会话）。字段来自两份清单的合并，见下面的 `cards` */
type CanvasCard = {
	id: string;
	title: string;
	updatedAt: number;
	messageCount?: number;
	ephemeral?: boolean;
};

function loadPositions(): Record<string, Pos> {
	try {
		const raw = localStorage.getItem(POS_KEY);
		if (raw === null) return {};
		const value = JSON.parse(raw) as unknown;
		if (typeof value !== "object" || value === null) return {};
		const out: Record<string, Pos> = {};
		for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
			const point = pos as { x?: unknown; y?: unknown } | null;
			if (typeof point?.x === "number" && typeof point?.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) {
				out[id] = { x: point.x, y: point.y };
			}
		}
		return out;
	} catch {
		// 存坏了就当没存过：画布不该因为一份坏 JSON 打不开
		return {};
	}
}

function savePositions(positions: Record<string, Pos>): void {
	try {
		localStorage.setItem(POS_KEY, JSON.stringify(positions));
	} catch {
		// 存不进去（隐私模式 / 配额满）只影响"下次还摆在这儿"，不该弹错
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

/** 卡片状态 → 一个色点 + 一句话。取的是这条会话自己的运行态（不是全局那条）。 */
type CardState = { tone: "running" | "approval" | "error" | "idle"; zh: string; en: string };

function stateOf(running: { status: string; activeTool?: { name?: string } | null } | undefined): CardState {
	if (!running || running.status === "idle") return { tone: "idle", zh: "空闲", en: "Idle" };
	if (running.status === "awaiting_approval") return { tone: "approval", zh: "等你确认", en: "Waiting for you" };
	if (running.status === "error") return { tone: "error", zh: "出错了", en: "Failed" };
	const tool = running.activeTool?.name;
	return { tone: "running", zh: tool ? `正在 ${tool}` : "正在跑", en: tool ? `Running ${tool}` : "Running" };
}

/**
 * 从一串"被拖动的边"和"静止的边"里挑一个最近的吸附目标。
 * 三条候选边（左 / 中 / 右，或上 / 中 / 下）× 所有静止卡片的同类边，取绝对距离最小且在容差内的。
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

	const viewportRef = useRef<HTMLDivElement | null>(null);
	const worldRef = useRef<HTMLDivElement | null>(null);
	const readoutRef = useRef<HTMLSpanElement | null>(null);
	const marqueeRef = useRef<HTMLDivElement | null>(null);
	const guideXRef = useRef<HTMLDivElement | null>(null);
	const guideYRef = useRef<HTMLDivElement | null>(null);
	/** 视口状态只活在这个 ref 里：每帧都变的东西不该进 React 状态 */
	const viewRef = useRef(loadView() ?? { x: 0, y: 0, k: 1 });
	/** 视口落盘的防抖句柄：拖动/缩放会连着触发几十次，不能每次都写 localStorage */
	const saveViewTimer = useRef<number | null>(null);
	const scheduleSaveView = useCallback(() => {
		if (saveViewTimer.current !== null) window.clearTimeout(saveViewTimer.current);
		saveViewTimer.current = window.setTimeout(() => {
			saveViewTimer.current = null;
			try {
				localStorage.setItem(VIEW_KEY, JSON.stringify(viewRef.current));
			} catch {
				// 同上：存不进去只是不记得视口，不影响使用
			}
		}, 300);
	}, []);

	const [positions, setPositions] = useState<Record<string, Pos>>(loadPositions);
	/** 拖动 / 框选要用最新坐标，但不想因此重挂监听 */
	const positionsRef = useRef(positions);
	useLayoutEffect(() => {
		positionsRef.current = positions;
	}, [positions]);

	/** 选中的卡片 id（数组：顺序稳定，渲染时判定用 Set） */
	const [selected, setSelected] = useState<string[]>([]);
	const selectedRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
		selectedRef.current = new Set(selected);
	}, [selected]);
	const selectedSet = useMemo(() => new Set(selected), [selected]);

	/** 卡片 DOM 引用表：拖动时要直接改 CSS 变量、量尺寸，都要拿到元素 */
	const cardElsRef = useRef(new Map<string, HTMLElement>());
	const setCardEl = useCallback((id: string, element: HTMLDivElement | null) => {
		if (element === null) cardElsRef.current.delete(id);
		else cardElsRef.current.set(id, element);
	}, []);

	/**
	 * 卡片清单：**在跑的排前面**，其余按最近更新。
	 * 画布上的"第一眼"应该是在干活的那几个，而不是昨天翻过的那条会话。
	 *
	 * 数据源要合并两份，否则会漏得很难看：
	 *   - `piProjects[].sessions` —— 扫描出来的**全部历史会话**（只有标题和时间）；
	 *   - `conversations` —— 最近碰过的那些（带消息数、临时标记，也会包含临时会话）。
	 * 只取 `conversations` 的话，侧栏明明几十条、画布上只有三条，看着就像坏了。
	 */
	const cards = useMemo<CanvasCard[]>(() => {
		const running = snapshot?.runningByConversation ?? {};
		const isBusy = (id: string) => {
			const status = running[id]?.status;
			return status !== undefined && status !== "idle";
		};
		const byId = new Map<string, CanvasCard>();
		for (const project of snapshot?.piProjects ?? []) {
			for (const session of project.sessions) {
				byId.set(session.id, { id: session.id, title: session.title, updatedAt: session.updatedAt });
			}
		}
		for (const conversation of snapshot?.conversations ?? []) {
			const existing = byId.get(conversation.id);
			byId.set(conversation.id, {
				id: conversation.id,
				title: conversation.title || existing?.title || "",
				updatedAt: Math.max(conversation.updatedAt, existing?.updatedAt ?? 0),
				messageCount: conversation.messageCount,
				ephemeral: conversation.ephemeral,
			});
		}
		return [...byId.values()]
			.sort((a, b) => Number(isBusy(b.id)) - Number(isBusy(a.id)) || b.updatedAt - a.updatedAt)
			.slice(0, MAX_CARDS);
	}, [snapshot?.conversations, snapshot?.piProjects, snapshot?.runningByConversation]);

	/**
	 * 给没摆过的会话补一个默认位置，然后**固定下来**。
	 * 不固定的话：某条会话更新后排序变了，它就会在网格里跳一格 —— 用户会以为画布在抽风。
	 */
	useEffect(() => {
		setPositions((current) => {
			let changed = false;
			const next = { ...current };
			cards.forEach((card, index) => {
				if (next[card.id]) return;
				next[card.id] = {
					x: GRID_ORIGIN_X + (index % GRID_COLS) * GRID_DX,
					y: GRID_ORIGIN_Y + Math.floor(index / GRID_COLS) * GRID_DY,
				};
				changed = true;
			});
			return changed ? next : current;
		});
	}, [cards]);

	/** 已消失的会话从选中里剔掉，否则「已选 3 张」可能其中两张早没了 */
	useEffect(() => {
		setSelected((current) => {
			const alive = current.filter((id) => cards.some((card) => card.id === id));
			return alive.length === current.length ? current : alive;
		});
	}, [cards]);

	/* ── 视口绘制：整层一个 transform，外加网格跟随 ─────────────── */
	const paint = useCallback(() => {
		const view = viewRef.current;
		const world = worldRef.current;
		const viewport = viewportRef.current;
		if (!world || !viewport) return;
		world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`;
		// 网格跟着一起平移/缩放：钉死在视口上的话，拖动时画面是"死"的，丢掉移动感
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

	/** 以某个屏幕点为锚缩放：锚点下的世界点在缩放前后必须停在原地 */
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

	/* ── 参考线（吸附时显示）。位置用 transform 直接改，不触发重渲染 ── */
	const hideGuides = useCallback(() => {
		for (const ref of [guideXRef, guideYRef]) {
			if (ref.current) ref.current.style.display = "none";
		}
	}, []);
	const showGuides = useCallback((atX: number | null, atY: number | null) => {
		// 世界坐标 → 屏幕坐标：屏幕 = 世界 × 缩放 + 平移（视口是定位祖先，所以不用减 rect）
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

	/* ── 平移（中键 / 空格 + 左键）───────────────────────── */
	const panRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
	/** 空格是否按住：按住时左键拖 = 平移（和 Figma 一致） */
	const spaceDownRef = useRef(false);
	const hoverRef = useRef(false);

	useEffect(() => {
		/** 焦点在输入框里就是打字，不能抢空格 */
		const isTyping = (target: EventTarget | null) => {
			const element = target as HTMLElement | null;
			return element !== null && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.code !== "Space" || isTyping(event.target)) return;
			/**
			 * 空格状态**不看悬停**就记下来：用户常常是先按空格再移鼠标进画布。
			 * 只有"阻止页面滚动 + 换光标"才需要悬停判断（否则在别处按空格会把页面滚动吃掉）。
			 */
			spaceDownRef.current = true;
			if (!hoverRef.current) return;
			viewportRef.current?.classList.add("can-pan");
			event.preventDefault();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.code !== "Space") return;
			spaceDownRef.current = false;
			viewportRef.current?.classList.remove("can-pan");
		};
		// 切窗口丢了 keyup 的话，空格会"粘住"，松手都变平移 —— 失焦时强制清掉
		const onBlur = () => {
			spaceDownRef.current = false;
			viewportRef.current?.classList.remove("can-pan");
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	/* ── 框选 ───────────────────────────────────────────── */
	const marqueeRefState = useRef<{ id: number; sx: number; sy: number; additive: boolean; moved: boolean } | null>(null);


	/* ── 卡片拖动（可能多张，带吸附） ────────────────────── */
	const dragRef = useRef<{
		pointerId: number;
		ids: string[];
		sx: number;
		sy: number;
		origins: Map<string, Pos>;
		moved: boolean;
	} | null>(null);

	const onCardPointerDown = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
		if (event.button !== 0) return;
		// 按在按钮上就是点按钮，别开始拖
		if ((event.target as HTMLElement).closest("button")) return;
		event.stopPropagation();

		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		let ids: string[];
		if (additive) {
			// 加减选：已经在里面就摘掉（本次不拖），否则加进去并一起拖
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
			// 点已选中的卡：保留整个选区，一起拖
			ids = [...selectedRef.current];
		} else {
			setSelected([id]);
			ids = [id];
		}

		const origins = new Map<string, Pos>();
		for (const each of ids) {
			const from = positionsRef.current[each];
			if (from) origins.set(each, from);
		}
		dragRef.current = { pointerId: event.pointerId, ids: [...origins.keys()], sx: event.clientX, sy: event.clientY, origins, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	/** 拖动中的位移（世界坐标）+ 吸附结果 */
	const applyDrag = useCallback((dx: number, dy: number) => {
		const drag = dragRef.current;
		if (drag === null) return;
		const k = viewRef.current.k;
		const tolerance = SNAP_PX / k;

		// 移动集合的包围盒（未吸附前）
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const [id, origin] of drag.origins) {
			const element = cardElsRef.current.get(id);
			if (!element) continue;
			minX = Math.min(minX, origin.x);
			minY = Math.min(minY, origin.y);
			maxX = Math.max(maxX, origin.x + element.offsetWidth);
			maxY = Math.max(maxY, origin.y + element.offsetHeight);
		}
		if (!Number.isFinite(minX)) return;

		// 静止卡片的边（不含正在拖的）
		const targetXs: number[] = [];
		const targetYs: number[] = [];
		for (const card of cards) {
			if (drag.origins.has(card.id)) continue;
			const element = cardElsRef.current.get(card.id);
			const pos = positionsRef.current[card.id];
			if (!element || !pos) continue;
			targetXs.push(pos.x, pos.x + element.offsetWidth / 2, pos.x + element.offsetWidth);
			targetYs.push(pos.y, pos.y + element.offsetHeight / 2, pos.y + element.offsetHeight);
		}

		const snapX = bestSnap([minX + dx, (minX + maxX) / 2 + dx, maxX + dx], targetXs, tolerance);
		const snapY = bestSnap([minY + dy, (minY + maxY) / 2 + dy, maxY + dy], targetYs, tolerance);
		const nextDx = dx + (snapX?.delta ?? 0);
		const nextDy = dy + (snapY?.delta ?? 0);

		for (const id of drag.ids) {
			const element = cardElsRef.current.get(id);
			if (!element) continue;
			element.style.setProperty("--card-dx", `${nextDx}px`);
			element.style.setProperty("--card-dy", `${nextDy}px`);
		}
		showGuides(snapX?.at ?? null, snapY?.at ?? null);
	}, [cards, showGuides]);

	/* ── 指针事件总入口（都挂在视口上，卡片用 capture 冒泡上来） ── */
	const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		// 按在卡片 / 工具条上的不归视口管
		if (target.closest(".canvas-card, .canvas-bar")) return;
		if (event.button === 1 || (event.button === 0 && spaceDownRef.current)) {
			panRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
			viewportRef.current?.classList.add("is-panning");
			viewportRef.current?.setPointerCapture(event.pointerId);
			return;
		}
		if (event.button !== 0) return;
		// 空白处左键拖 = 框选
		marqueeRefState.current = {
			id: event.pointerId,
			sx: event.clientX,
			sy: event.clientY,
			additive: event.shiftKey || event.metaKey || event.ctrlKey,
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
				for (const id of drag.ids) cardElsRef.current.get(id)?.classList.add("is-dragging");
			}
			// 世界位移 = 屏幕位移 ÷ 缩放（漏掉除法就是"放大后拖动跑得比鼠标快"）
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

	/** 框选落定：把矩形换算成世界坐标，跟每张卡的世界包围盒求交 */
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
			for (const card of cards) {
				const element = cardElsRef.current.get(card.id);
				const pos = positionsRef.current[card.id];
				if (!element || !pos) continue;
				// 相交即选中（不要求完全包住 —— 完全包住在小缩放时几乎选不中任何东西）
				const overlaps =
					pos.x < worldRight && pos.x + element.offsetWidth > worldLeft && pos.y < worldBottom && pos.y + element.offsetHeight > worldTop;
				if (overlaps) hits.push(card.id);
			}
			setSelected((current) => (additive ? [...new Set([...current, ...hits])] : hits));
		},
		[cards],
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
			// 注意顺序：先提交、再隐藏。反过来写会让 commitMarquee 读到 display:none 直接返回
			if (marquee.moved) commitMarquee(marquee.additive);
			else if (!marquee.additive) setSelected([]);
			if (marqueeRef.current) marqueeRef.current.style.display = "none";
		}

		const drag = dragRef.current;
		if (drag === null || event.pointerId !== drag.pointerId) return;
		dragRef.current = null;
		hideGuides();
		for (const id of drag.ids) cardElsRef.current.get(id)?.classList.remove("is-dragging");
		if (!drag.moved) {
			// 没动过：什么也没发生，交给 click / dblclick
			for (const id of drag.ids) {
				const element = cardElsRef.current.get(id);
				element?.style.removeProperty("--card-dx");
				element?.style.removeProperty("--card-dy");
			}
			return;
		}
		// 松手：先读临时位移、清掉，再把新坐标写进状态（否则会叠加两次）
		const deltas = new Map<string, { dx: number; dy: number }>();
		for (const id of drag.ids) {
			const element = cardElsRef.current.get(id);
			if (!element) continue;
			deltas.set(id, {
				dx: Number.parseFloat(element.style.getPropertyValue("--card-dx")) || 0,
				dy: Number.parseFloat(element.style.getPropertyValue("--card-dy")) || 0,
			});
			element.style.removeProperty("--card-dx");
			element.style.removeProperty("--card-dy");
		}
		setPositions((current) => {
			const next = { ...current };
			for (const [id, delta] of deltas) {
				const origin = drag.origins.get(id);
				if (!origin) continue;
				next[id] = { x: origin.x + delta.dx, y: origin.y + delta.dy };
			}
			savePositions(next);
			return next;
		});
	};

	/* ── 滚轮：有 ⌘/Ctrl 就缩放（触控板捏合同样带 ctrlKey），否则平移 ── */
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				const rect = viewport.getBoundingClientRect();
				const factor = Math.exp(-event.deltaY * 0.0025);
				zoomAt(event.clientX - rect.left, event.clientY - rect.top, viewRef.current.k * factor);
				return;
			}
			viewRef.current.x -= event.deltaX;
			viewRef.current.y -= event.deltaY;
			paint();
			scheduleSaveView();
		};
		// passive: false —— 不拦住的话浏览器会同时缩放整个页面
		viewport.addEventListener("wheel", onWheel, { passive: false });
		return () => viewport.removeEventListener("wheel", onWheel);
	}, [paint, zoomAt, scheduleSaveView]);

	/** 适应内容：把当前所有卡片的包围盒塞进视口 */
	const fit = useCallback(() => {
		const viewport = viewportRef.current;
		const world = worldRef.current;
		if (!viewport || !world) return;
		// 标签被隐藏时 clientWidth 是 0，这时候算出来的缩放会爆掉
		if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const element of world.querySelectorAll<HTMLElement>(".canvas-card")) {
			// offsetLeft/Top 不受 transform 影响，正好是世界坐标
			minX = Math.min(minX, element.offsetLeft);
			minY = Math.min(minY, element.offsetTop);
			maxX = Math.max(maxX, element.offsetLeft + element.offsetWidth);
			maxY = Math.max(maxY, element.offsetTop + element.offsetHeight);
		}
		if (!Number.isFinite(minX)) return;
		const pad = 40;
		/**
		 * 缩放上限到 1（只有两三张卡时不要按比例"放大填满"）、下限到 `FIT_MIN_K`
		 * （卡片多时不要缩成看不清的小方块）。适应内容只应该把东西装进来。
		 */
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
		// 装得下就居中；装不下（被 FIT_MIN_K 卡住了）就靠左上，
		// 否则"居中"会把最前面那几排直接推到屏幕外，打开就是半张图。
		const centeredX = (viewport.clientWidth - (maxX - minX) * k) / 2 - minX * k;
		const centeredY = (viewport.clientHeight - (maxY - minY) * k) / 2 - minY * k;
		viewRef.current.x = Math.max(centeredX, pad - minX * k);
		viewRef.current.y = Math.max(centeredY, pad - minY * k);
		paint();
		scheduleSaveView();
	}, [paint, scheduleSaveView]);

	const reset = useCallback(() => {
		viewRef.current = { x: 0, y: 0, k: 1 };
		paint();
		scheduleSaveView();
	}, [paint, scheduleSaveView]);

	/**
	 * 第一次打开（本机从没存过位置）自动「适应内容」。
	 * 不自适应的话，用户看到的是从左上角开始的半截网格；自适应一眼就看到全部会话。
	 */
	const autoFitRef = useRef(loadView() === null && Object.keys(positions).length === 0);
	useEffect(() => {
		if (!autoFitRef.current) return;
		// 一定要等到**每张卡都有坐标**：没坐标的卡是 visibility:hidden、left/top 也没有，
		// 这时候量出来的包围盒是「全部堆在 (0,0)」，会算出一个离谱的放大倍数。
		if (cards.length === 0 || !cards.every((card) => positions[card.id] !== undefined)) return;
		// 再等一帧：left/top 刚写进去，offsetWidth 这一帧才量得准
		const frame = window.requestAnimationFrame(() => {
			autoFitRef.current = false;
			fit();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [cards, positions, fit]);

	const running = snapshot?.runningByConversation ?? {};

	return (
		<div className="canvas-view">
			<div
				className="canvas-viewport"
				ref={viewportRef}
				onPointerDown={onViewportPointerDown}
				onPointerMove={onViewportPointerMove}
				onPointerUp={endPointer}
				onPointerCancel={endPointer}
				onPointerEnter={() => {
					hoverRef.current = true;
					// 先进画布再按的空格（或者按着空格移进来）：补上平移光标
					if (spaceDownRef.current) viewportRef.current?.classList.add("can-pan");
				}}
				onPointerLeave={() => {
					hoverRef.current = false;
					viewportRef.current?.classList.remove("can-pan");
				}}
			>
				<div className="canvas-world" ref={worldRef}>
					{cards.map((card) => {
						const pos = positions[card.id];
						const state = stateOf(running[card.id]);
						const isSelected = selectedSet.has(card.id);
						return (
							<div
								className={`canvas-card${isSelected ? " is-selected" : ""}`}
								key={card.id}
								data-conversation-id={card.id}
								ref={(element) => setCardEl(card.id, element)}
								style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}
								onPointerDown={(event) => onCardPointerDown(event, card.id)}
								onDoubleClick={() => switchConversation(card.id)}
								title={t("双击回到这条会话", "Double-click to open this session")}
							>
								<div className="canvas-card-head">
									<span className={`canvas-dot${state.tone === "idle" ? "" : ` is-${state.tone}`}`} />
									<span className="canvas-card-title">{card.title || card.id.slice(0, 8)}</span>
								</div>
								<div className="canvas-card-meta">
									{card.messageCount !== undefined ? (
										<span>
											{card.messageCount} {t("条", "msgs")}
										</span>
									) : null}
									{card.ephemeral ? <span>· {t("临时", "ephemeral")}</span> : null}
								</div>
								<div className={`canvas-card-state${state.tone === "idle" ? "" : ` is-${state.tone}`}`}>
									{t(state.zh, state.en)}
								</div>
								<button type="button" className="canvas-card-open" onClick={() => switchConversation(card.id)}>
									{t("打开", "Open")}
								</button>
							</div>
						);
					})}
				</div>
				{/* 框选矩形：屏幕坐标（不跟缩放走），拖动时用 style 直接改 */}
				<div className="canvas-marquee" ref={marqueeRef} />
				{/* 吸附参考线：一条竖、一条横，最多各一条 */}
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
					{cards.length} {t("条会话", "sessions")}
				</span>
				{selected.length > 0 ? (
					<>
						<span className="canvas-bar-sel">
							{t(`已选 ${selected.length}`, `${selected.length} selected`)}
						</span>
						<button type="button" onClick={() => setSelected([])}>
							{t("取消选择", "Clear")}
						</button>
					</>
				) : null}
			</div>
			<div className="canvas-hint">
				{t(
					"拖空白框选 · 拖卡片移动 · 滚轮平移 · ⌘/Ctrl+滚轮缩放 · 空格+拖=平移",
					"Drag to box-select · drag cards · wheel to pan · ⌘/Ctrl+wheel to zoom · space+drag to pan",
				)}
			</div>
		</div>
	);
}
