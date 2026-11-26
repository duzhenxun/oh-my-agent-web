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
import type { CanvasDoc, CanvasNode, CanvasNodeStatus } from "../types.ts";
import { useAppState } from "../store.ts";
import { requestInterruptSpeech } from "../speech-control.ts";
import {
	canvasDeleteNodes,
	canvasMoveNodes,
	canvasSetStatus,
	canvasStartNode,
	canvasSuggest,
	canvasUpdateNode,
	interrupt,
	sendMessage,
} from "../ws.ts";
import { useT } from "../use-language.ts";

/**
 * 缩放上下限（手动：滚轮 / 捏合 / ± 按钮）。
 * 下限从 0.2 抬到 0.35（用户 2026-11-25：「全局缩小时不要太小」）：
 * 0.2 的时候一张卡只有 48px 宽、字号不到 3px，除了色块什么也看不出来。
 */
const MIN_K = 0.35;
const MAX_K = 2.5;
/**
 * 「看全局」的缩放下限：**比手动下限还高一档**。
 *
 * 以前它一路缩到 MIN_K，节点多了就是一堆看不清的小方块；现在宁可只装下大部分、
 * 靠平移看剩下的，也不再往下缩 —— 真要更小可以自己用 − 或滚轮（能到 MIN_K）。
 */
const FIT_MIN_K = 0.5;
/**
 * 切「缩略」（只留编号 + 标题，不显描述）的门槛。
 *
 * 走势：0.5（一开始）→ 0.4（2026-11-26「先不要马上变成点」）→ 0.6 → 0.7（同日「0.7 以下就不显描述」）
 * → **0.4（同日收尾定稿，用户 2026-11-26：「缩小到 0.4 时才只显示标题，0.4 以上保持原来卡片」）**。
 * 0.7 那一档太早了：0.5～0.7 明明还读得清描述，却被抽成一行标题。
 * 现在：**> 0.4 是完整卡片**（标题 + 描述 + 状态），**≤ 0.4 只留编号 + 标题**。
 * 这个数与悬停预览的开关（`k < FAR_K` 才弹预览）同一档，两套行为不会打架。
 */
const FAR_K = 0.4;
/**
 * 缩略态卡片的**固定**高度（世界坐标），与 `canvas.css` 的
 * `.canvas-view.is-far .canvas-node { height: 34px }` 是一个数。
 *
 * 为什么要写成常量而不用量出来的值：连线端点要的是「缩略时的高度」，
 * 而量高度那一步量的是完整卡片（布局要用它）。两套数字分开，
 * 缩过门槛时连线才能立刻跟着卡片变矮，不用等下一轮重排。
 */
const FAR_NODE_HEIGHT = 34;
/** 与 `panel-tab-dnd.ts` 一致：5px 内算点击，不算拖 */
const DRAG_THRESHOLD = 5;
/** 吸附距离（**屏幕**像素）：缩得越小越难对齐，所以按屏幕算、用的时候再除以缩放 */
const SNAP_PX = 6;
/** 节点的世界宽度：和 CSS 里的 `.canvas-node` 保持一致（算连线端点要用） */
const NODE_WIDTH = 240;
/** 连线终点离卡片侧边留的空：箭头尖正好停在卡片外面，不压在边框和字上 */
const ARROW_GAP = 7;
/** 同一列卡片之间至少留的空隙（世界坐标） */
const COLUMN_GAP = 20;

/**
 * 还没量到真实高度时的估算：标题 + 说明按字数折行，再加状态行。
 * 只是第一帧的兜底 —— 渲染完 `useLayoutEffect` 会拿实测高度重排一次。
 */
function estimateNodeHeight(node: CanvasNode): number {
	const titleLines = Math.max(1, Math.ceil(node.title.length / 15));
	const detailLines = node.detail ? Math.ceil(node.detail.length / 17) : 0;
	return 46 + titleLines * 19 + detailLines * 19;
}

/** 布局风格（本机偏好，按会话存）：卡片 = 自由摆放；另外两种是客户端按依赖重排 */
type LayoutStyle = "card" | "timeline" | "checklist" | "mindmap" | "swimlane";
const STYLE_KEY = "agent-web.canvas.style.v1";

/** 节点类型 → 图标 + 中文名。全是 task 的图读起来很闷，所以类型要能看出来 */
const KIND_META: Record<string, { icon: string; zh: string; en: string }> = {
	task: { icon: "•", zh: "待办项", en: "Task" },
	milestone: { icon: "▲", zh: "里程碑", en: "Milestone" },
	risk: { icon: "!", zh: "风险", en: "Risk" },
	doc: { icon: "▤", zh: "参考", en: "Doc" },
	decision: { icon: "◆", zh: "决策", en: "Decision" },
};

function kindOf(node: CanvasNode): string {
	return node.kind && KIND_META[node.kind] ? node.kind : "task";
}

/**
 * 按依赖算每个节点的层级（和 `server/session/canvas.ts` 的 layout 同一套规则）：
 * depth = 到它的最长前置链。时间线风格直接拿它当列号。
 */
function depthsOf(nodes: readonly CanvasNode[], edges: readonly { from: string; to: string }[]): Map<string, number> {
	const incoming = new Map<string, string[]>();
	for (const node of nodes) incoming.set(node.id, []);
	for (const edge of edges) incoming.get(edge.to)?.push(edge.from);
	const cache = new Map<string, number>();
	const visiting = new Set<string>();
	const depthOf = (id: string): number => {
		const hit = cache.get(id);
		if (hit !== undefined) return hit;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		let depth = 0;
		for (const parent of incoming.get(id) ?? []) depth = Math.max(depth, depthOf(parent) + 1);
		visiting.delete(id);
		cache.set(id, depth);
		return depth;
	};
	const out = new Map<string, number>();
	for (const node of nodes) out.set(node.id, depthOf(node.id));
	return out;
}

/**
 * 思维导图（**从左往右的树**，和 XMind 逻辑图一个排法）。
 *
 * 为什么不是放射状：我们的节点是 240px 宽的卡片，放射状下同一圈的卡片会互相压、
 * 跨支的线还会交叉，看着像一堆散点（用户 2026-11-23 直接说"做的不对"）。
 * 卡片天生适合横着排：深度 → 列，叶子按顺序占行，父节点对齐子节点的**中点**。
 *
 * 行高用实测高度（标题换行的卡片本来就是两倍高），否则又会摞在一起。
 */
function mindmapLayout(
	nodes: readonly CanvasNode[],
	edges: readonly { from: string; to: string }[],
	heightOf: (id: string) => number,
): Map<string, Pos> {
	const map = new Map<string, Pos>();
	if (nodes.length === 0) return map;

	const incoming = new Map<string, number>();
	for (const node of nodes) incoming.set(node.id, 0);
	const children = new Map<string, string[]>();
	for (const edge of edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
		const list = children.get(edge.from) ?? [];
		list.push(edge.to);
		children.set(edge.from, list);
	}

	const COLUMN = 340; // 240 卡片宽 + 100 连线空间
	const GAP = 20;
	const left = 40;
	const top = 64;

	const placed = new Set<string>();
	let cursorY = top;

	/** 后序：先把子树排完，再把自己对准子节点中点 */
	const visit = (id: string, depth: number, stack: Set<string>): number => {
		if (placed.has(id)) return map.get(id)?.y ?? cursorY;
		if (stack.has(id)) return cursorY; // 环：就地兜住，不递归
		stack.add(id);
		placed.add(id);

		const kids = (children.get(id) ?? []).filter((kid) => !placed.has(kid) && !stack.has(kid));
		let y: number;
		if (kids.length === 0) {
			y = cursorY;
			cursorY += heightOf(id) + GAP;
		} else {
			const kidYs = kids.map((kid) => visit(kid, depth + 1, stack));
			// 子节点各自的**中线**取平均，再把自己对到那个中线上 —— 别混自己的高度，
			// 混了之后父节点会往下漂、压住上面那条支（用户 2026-11-23 报的"容易压住"）。
			const firstMid = kidYs[0]! + heightOf(kids[0]!) / 2;
			const lastKid = kids[kids.length - 1]!;
			const lastMid = kidYs[kidYs.length - 1]! + heightOf(lastKid) / 2;
			y = (firstMid + lastMid) / 2 - heightOf(id) / 2;
		}
		stack.delete(id);
		map.set(id, { x: left + depth * COLUMN, y });
		return y;
	};

	// 根：没有入边的（多个就依次往下排）；全是环就拿第一个
	const roots = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
	if (roots.length === 0 && nodes[0] !== undefined) roots.push(nodes[0].id);
	for (const root of roots) visit(root, 0, new Set());

	// 走不到的（环里的、孤立的）：单独一列排在下面，别让它们消失
	const orphans = nodes.filter((node) => !placed.has(node.id));
	for (const node of orphans) {
		map.set(node.id, { x: left, y: cursorY });
		cursorY += heightOf(node.id) + GAP;
	}
	return map;
}

/** 泳道的一条带（渲染成世界坐标里的一块底色 + 标题） */
type LaneBand = { x: number; y: number; w: number; h: number; label: string };

/**
 * 泳道图：**根节点的每个一级分支 = 一条泳道**，支里的步骤按深度从左到右排。
 *
 * 为什么拿一级分支当泳道：节点上没有"负责人/模块"这种字段，凭空造一个还得让 agent 去填。
 * 而一张计划里，根下面那一层本来就是"并行推进的几摊事"——直接拿它当泳道，语义和视觉都对得上。
 * 掉不进任何分支的节点（环里的、孤立的）单独放在最后一条「其他」泳道。
 */
function swimlaneLayout(
	nodes: readonly CanvasNode[],
	edges: readonly { from: string; to: string }[],
	heightOf: (id: string) => number,
): { positions: Map<string, Pos>; bands: LaneBand[] } {
	const positions = new Map<string, Pos>();
	const bands: LaneBand[] = [];
	if (nodes.length === 0) return { positions, bands };

	const children = new Map<string, string[]>();
	const incoming = new Map<string, number>();
	for (const node of nodes) incoming.set(node.id, 0);
	for (const edge of edges) {
		children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}

	const COLUMN = 320;
	const LEFT = 40;
	const TOP = 64;
	const LANE_GAP = 26;
	const ROW_GAP = 18;
	const BAND_PAD = 16;
	/** 泳道标题占的高度：不留出来的话标签会压在第一个节点上 */
	const LABEL_SPACE = 26;

	const root = nodes.find((node) => (incoming.get(node.id) ?? 0) === 0) ?? nodes[0]!;
	const lanes = (children.get(root.id) ?? []).filter((id) => nodes.some((node) => node.id === id));

	/** 一支的分支成员（含支头本身） */
	const collect = (headId: string): string[] => {
		const out: string[] = [];
		const stack = [headId];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (seen.has(id) || id === root.id) continue;
			seen.add(id);
			out.push(id);
			for (const kid of children.get(id) ?? []) stack.push(kid);
		}
		return out;
	};

	let cursorY = TOP;
	const placeLane = (label: string, ids: string[], depthOf: Map<string, number>) => {
		if (ids.length === 0) return;
		// 泳道内按深度分行：同深度的往下一行一行排
		const byDepth = new Map<number, string[]>();
		for (const id of ids) {
			const depth = depthOf.get(id) ?? 0;
			byDepth.set(depth, [...(byDepth.get(depth) ?? []), id]);
		}
		const depths = [...byDepth.keys()].sort((a, b) => a - b);
		let bandHeight = 0;
		let rowCursor = cursorY + LABEL_SPACE + BAND_PAD / 2;
		const vertical = new Map<string, number>();
		for (const depth of depths) {
			const group = byDepth.get(depth)!;
			let rowY = rowCursor;
			let rowHeight = 0;
			for (const id of group) {
				vertical.set(id, rowY);
				rowY += heightOf(id) + ROW_GAP;
				rowHeight = Math.max(rowHeight, heightOf(id));
			}
			rowCursor = rowY;
			bandHeight = Math.max(bandHeight, rowCursor - cursorY);
		}
		bandHeight = Math.max(bandHeight, LABEL_SPACE + 56) + BAND_PAD;
		const maxDepth = depths[depths.length - 1] ?? 0;
		const minDepth = depths[0] ?? 0;
		bands.push({
			x: LEFT - BAND_PAD,
			y: cursorY,
			w: (maxDepth - minDepth + 1) * COLUMN + BAND_PAD * 2,
			h: bandHeight,
			label,
		});
		for (const id of ids) {
			positions.set(id, {
				x: LEFT + ((depthOf.get(id) ?? 0) - minDepth) * COLUMN,
				y: vertical.get(id) ?? cursorY + LABEL_SPACE + BAND_PAD / 2,
			});
		}
		cursorY += bandHeight + LANE_GAP;
	};

	// 深度：从根算（根 = 0），每条泳道内部再把支头挪到第一列
	const depthOf = depthsOf(nodes, edges);

	if (lanes.length === 0) {
		// 没有分支（只有一个根，或者全是环）：就一条泳道
		placeLane(
			root.title,
			nodes.filter((node) => node.id !== root.id).map((node) => node.id),
			depthOf,
		);
	} else {
		const covered = new Set<string>();
		for (const headId of lanes) {
			const label = nodes.find((node) => node.id === headId)?.title ?? headId;
			const ids = collect(headId);
			for (const id of ids) covered.add(id);
			placeLane(label, ids, depthOf);
		}
		const orphans = nodes.filter((node) => node.id !== root.id && !covered.has(node.id)).map((node) => node.id);
		placeLane("其他", orphans, depthOf);
	}

	// 根自己：放在最上面一条细带里，左边对齐
	const rootHeight = heightOf(root.id);
	positions.set(root.id, { x: LEFT, y: TOP });
	for (const band of bands) {
		// 所有泳道整体下移，给根让出位置
		band.y += rootHeight + LANE_GAP;
	}
	for (const [id, pos] of positions) {
		if (id === root.id) continue;
		positions.set(id, { x: pos.x, y: pos.y + rootHeight + LANE_GAP });
	}
	return { positions, bands };
}

/** 非卡片样式下"手摆的位置"存本机：会话 → 样式 → 节点 id → 坐标 */
const MOVES_KEY = "agent-web.canvas.moves.v1";

function loadMoves(): Record<string, Record<string, Record<string, Pos>>> {
	try {
		const raw = localStorage.getItem(MOVES_KEY);
		if (raw === null) return {};
		const value = JSON.parse(raw) as unknown;
		return typeof value === "object" && value !== null
			? (value as Record<string, Record<string, Record<string, Pos>>>)
			: {};
	} catch {
		return {};
	}
}

function saveMoves(moves: Record<string, Record<string, Record<string, Pos>>>): void {
	try {
		localStorage.setItem(MOVES_KEY, JSON.stringify(moves));
	} catch {
		// 存不进去只影响"下次还摆在这儿"
	}
}

function loadStyle(conversationId: string | null): LayoutStyle {
	try {
		const raw = localStorage.getItem(STYLE_KEY);
		if (raw === null || conversationId === null) return "card";
		const value = JSON.parse(raw) as Record<string, unknown> | null;
		const stored = value?.[conversationId];
		return stored === "timeline" || stored === "checklist" || stored === "mindmap" || stored === "swimlane"
			? stored
			: "card";
	} catch {
		return "card";
	}
}

function saveStyle(conversationId: string | null, style: LayoutStyle): void {
	if (conversationId === null) return;
	try {
		const raw = localStorage.getItem(STYLE_KEY);
		const value = (raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)) as Record<string, unknown>;
		value[conversationId] = style;
		localStorage.setItem(STYLE_KEY, JSON.stringify(value));
	} catch {
		// 存不进去只影响"下次还是这个风格"
	}
}

type Pos = { x: number; y: number };

/** 状态 → 色点 / 文案 / 颜色类 */
function statusOf(node: CanvasNode): { tone: string; zh: string; en: string } {
	if (node.status === "doing") return { tone: "doing", zh: "正在做", en: "Doing" };
	if (node.status === "done") return { tone: "done", zh: "已完成", en: "Done" };
	if (node.status === "blocked") return { tone: "blocked", zh: "卡住了", en: "Blocked" };
	return { tone: "todo", zh: "待办", en: "To do" };
}

/**
 * 「这一轮跑到哪了」→ 一行字。
 *
 * 优先说**正在跑什么工具**（带参数摘要，比"正在输出"有用得多），没有工具就跑秒表。
 * 秒数从 `turnStartedAt` 算：用户在画布上盯着的就是"它跑了多久了"。
 */
function describeRun(
	run: {
		status: string;
		turnStartedAt?: number | null;
		activeTool?: { name?: string; argsSummary?: string } | null;
		retrying?: unknown;
	},
	t: (zh: string, en: string) => string,
): string {
	const elapsed =
		typeof run.turnStartedAt === "number" && run.turnStartedAt > 0
			? `${Math.max(0, Math.floor((Date.now() - run.turnStartedAt) / 1000))}s`
			: "";
	const tool = run.activeTool?.name;
	if (tool) {
		const args = (run.activeTool?.argsSummary ?? "").replace(/\s+/g, " ").trim();
		const short = args.length > 26 ? `${args.slice(0, 26)}…` : args;
		return [short === "" ? `正在 ${tool}` : `正在 ${tool} · ${short}`, elapsed].filter(Boolean).join(" · ");
	}
	if (run.retrying) return [t("等模型重试…", "Retrying…"), elapsed].filter(Boolean).join(" · ");
	if (run.status === "awaiting_approval") return t("等你确认", "Waiting for you");
	return [t("正在输出…", "Writing…"), elapsed].filter(Boolean).join(" · ");
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

export function CanvasView({ onOpenFile }: { root: string | null; onOpenFile: (path: string) => void }) {
	const t = useT();
	const { snapshot, newSession, pendingNewChat } = useAppState();
	/**
	 * 「新会话界面」上服务端**什么都还没建**，快照里 `active` 还是上一条会话 ——
	 * 直接拿它的话，新建会话时右边会挂着上一个会话的画布（用户 2026-11-22 报的）。
	 * 这一屏就当成"没有会话"，画布显示空状态。
	 */
	const onEmptyScreen = newSession !== null || pendingNewChat;
	const doc: CanvasDoc | null = onEmptyScreen ? null : (snapshot?.canvas ?? null);
	const conversationId = onEmptyScreen ? null : (snapshot?.active.conversationId ?? null);

	/**
	 * 现在看的是哪一层：`[]` = 主图，`[id]` = 那个节点的子计划（双击进入）。
	 * 只往下钻一层就够了 —— 再深人自己也跟不住，需要更深说明主图那一步拆得不够。
	 */
	const [path, setPath] = useState<string[]>([]);
	const parentId = path.length === 0 ? null : (path[path.length - 1] ?? null);
	/** 换会话就回到主图（**不能把 parentId 写进依赖**：一进子层它就会变，立刻被弹回去） */
	useEffect(() => {
		setPath([]);
	}, [conversationId]);
	const level = useMemo(() => {
		if (doc === null)
			return { nodes: [] as CanvasNode[], edges: [] as CanvasDoc["edges"], host: null as CanvasNode | null };
		if (parentId === null) return { nodes: doc.nodes, edges: doc.edges, host: null as CanvasNode | null };
		const host = doc.nodes.find((node) => node.id === parentId) ?? null;
		return { nodes: host?.sub?.nodes ?? [], edges: host?.sub?.edges ?? [], host };
	}, [doc, parentId]);
	/** 子层里发现宿主没了（被删/重画）→ 自动退回主图 */
	useEffect(() => {
		if (parentId !== null && level.host === null) setPath([]);
	}, [parentId, level.host]);

	const viewportRef = useRef<HTMLDivElement | null>(null);
	/** 外层容器（空状态也渲染）：手势必须挂在这里，否则空画布时触摸板捏合会缩放整个网页 */
	const rootRef = useRef<HTMLDivElement | null>(null);
	const worldRef = useRef<HTMLDivElement | null>(null);
	const readoutRef = useRef<HTMLSpanElement | null>(null);
	const marqueeRef = useRef<HTMLDivElement | null>(null);
	const guideXRef = useRef<HTMLDivElement | null>(null);
	const guideYRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 视口状态：**每次打开画布都从「重置」那个视角开始**（100%，原点）。
	 *
	 * 为什么不再记住上次的平移/缩放，也不自动"适应内容"：用户要的是"打开就看到
	 * 自己画的那张图原本的样子"，而不是浏览器替他缩小到全局、或者跳回上次拖到的角落。
	 * 要看全局有「看全局」按钮，随时点。
	 */
	const viewRef = useRef({ x: 0, y: 0, k: 1 });

	/**
	 * 拖动后的**乐观坐标**：松手立刻先摆在原地，等快照回来。
	 * `rev` 一变就清掉 —— 服务端才是坐标的事实源（用户摆的位置也是工作产物，得存服务端）。
	 */
	const [pending, setPending] = useState<Record<string, Pos>>({});

	/** 右键菜单：`nodeId` 为 null 表示点在空白处 */
	const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string | null } | null>(null);
	/**
	 * 菜单的**实际落点**：必须量出来再定。
	 *
	 * 以前是拿「菜单项数 × 26」估高度去夹下边缘：13 项估成 338px，菜单被一路顶到上面去，
	 * 左上角那个小三角就指向了空气（用户 2026-11-26：「右键时弹窗不是指的自己」）。
	 * 现在量真实宽高：装不下就往左上翻，小三角跟着翻到对应的角。
	 */
	const [menuBox, setMenuBox] = useState<{ left: number; top: number; flipX: boolean; flipY: boolean } | null>(null);
	const menuElRef = useRef<HTMLDivElement | null>(null);
	/** 「N 项产出」弹层：1:1 时悬停预览不出现，产出得有别的入口 */
	const [artifactsOf, setArtifactsOf] = useState<{ id: string; x: number; y: number } | null>(null);
	/** 「就这几步说两句」的候选指令（AI 生成，失败时服务端退回固定候选） */
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [suggesting, setSuggesting] = useState(false);

	/**
	 * 「就这几步说两句」的输入框：`nodeIds` = 这次要带的选区（右键的那个节点不在选区里时，就只有它）。
	 * 发出去是一条普通消息，但正文里带着节点 id 和现状 —— 让 agent 知道"只改这几个"。
	 */
	const [ask, setAsk] = useState<{ x: number; y: number; nodeIds: string[]; text: string } | null>(null);

	/** 重命名（内联输入）：先摆出当前值，Enter 保存 / Esc 取消 */
	const [editing, setEditing] = useState<{ id: string; title: string; detail: string } | null>(null);

	/** 右键位置换算成"相对画布容器"的坐标（菜单是容器的子元素，不能直接用 clientX/Y） */
	const openMenuAt = useCallback((event: React.MouseEvent, nodeId: string | null = null) => {
		const rect = rootRef.current?.getBoundingClientRect();
		const x = event.clientX - (rect?.left ?? 0);
		const y = event.clientY - (rect?.top ?? 0);
		// 落点要重量：新菜单高度不一样，上一次算出来的位置不一定是这一次的
		setMenuBox(null);
		return { x, y, nodeId };
	}, []);

	/** 菜单渲出来以后再量一次宽高，然后夹进视口；往哪边翻要记下来，小三角跟着走 */
	useLayoutEffect(() => {
		if (menu === null) {
			setMenuBox(null);
			return;
		}
		const element = menuElRef.current;
		const viewport = viewportRef.current;
		if (element === null || viewport === null) return;
		const GAP = 10;
		const EDGE = 4;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		const flipX = menu.x + GAP + width > viewport.clientWidth - EDGE;
		const flipY = menu.y + GAP + height > viewport.clientHeight - EDGE;
		setMenuBox({
			left: flipX
				? Math.max(EDGE, menu.x - GAP - width)
				: Math.min(menu.x + GAP, Math.max(EDGE, viewport.clientWidth - EDGE - width)),
			top: flipY
				? Math.max(EDGE, menu.y - GAP - height)
				: Math.min(menu.y + GAP, Math.max(EDGE, viewport.clientHeight - EDGE - height)),
			flipX,
			flipY,
		});
	}, [menu]);

	const closeMenu = useCallback(() => setMenu(null), []);

	const [selected, setSelected] = useState<string[]>([]);
	const selectedRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
		selectedRef.current = new Set(selected);
	}, [selected]);

	/**
	 * 这一轮正在做画布上的哪一步（宿主在图一开跑时记下的）+ 这条会话的运行态。
	 * 节点上的实时进度就靠这两个：正在跑什么工具、跑了多久。
	 */
	const runningNodeId = snapshot?.canvasRunningNodeId ?? null;
	const run = conversationId === null ? undefined : snapshot?.runningByConversation?.[conversationId];
	/** 秒表：只有真有节点在跑时才每秒滴答一次（不跑的时候不制造重渲染） */
	const [, setTick] = useState(0);
	useEffect(() => {
		if (runningNodeId === null) return;
		const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
		return () => window.clearInterval(timer);
	}, [runningNodeId]);

	/** 节点的实际高度（连线端点要用；宽度是固定常量） */
	const [heights, setHeights] = useState<Record<string, number>>({});
	const nodeElsRef = useRef(new Map<string, HTMLElement>());
	/**
	 * 当前是不是「缩略态」（`k ≤ FAR_K`）。
	 *
	 * 用 React state 而不仅是一个 class：缩略时卡片**变矮**（`FAR_NODE_HEIGHT`），
	 * 连线端点得跟着改 —— 而连线是 `useMemo` 算出来的，不给它一个依赖就永远用老高度，
	 * 表现为「字还在卡上，线却挂到半空中」（用户 2026-11-26：「显示标题时外面的线位置也要跟着调」）。
	 * `farRef` 负责去重：只在跨门槛那一下触发一次重渲染，不是每帧都触发。
	 */
	const [far, setFar] = useState(false);
	const farRef = useRef(false);

	/**
	 * 布局风格：卡片（自由摆放，服务端坐标） / 时间线（按依赖分栏） / 清单（单列竖排）。
	 * 后两种是**客户端按依赖重排**的只读视图 —— 那种排法里"拖"没有意义，所以禁拖。
	 */
	const [style, setStyle] = useState<LayoutStyle>(() => loadStyle(conversationId));
	const styleRef = useRef(style);
	useLayoutEffect(() => {
		styleRef.current = style;
	}, [style]);
	// 换会话要跟着换回那条会话自己的风格
	useEffect(() => {
		setStyle(loadStyle(conversationId));
	}, [conversationId, parentId]);
	const changeStyle = useCallback(
		(next: LayoutStyle) => {
			setStyle(next);
			saveStyle(conversationId, next);
		},
		[conversationId],
	);

	/**
	 * 时间线 / 清单风格下算出来的坐标（卡片风格是 null，用服务端的）。
	 *
	 * 间距**按实测高度**堆：写死间距的话，标题一换行节点就 200 多高，卡片直接摞在一起
	 * （用户 2026-11-22 报的"清单时距离太近"）。`heights` 是渲染后量出来的，
	 * 第一帧还没量到时用估算值兜着，量到之后会再排一次。
	 */
	const layoutResult = useMemo((): { positions: Map<string, Pos> | null; bands: LaneBand[] } => {
		if (style === "card" || doc === null) return { positions: null, bands: [] };
		if (style === "swimlane") {
			return swimlaneLayout(level.nodes, level.edges, (id) => heights[id] ?? 128);
		}
		const depths = depthsOf(level.nodes, level.edges);
		const ordered = [...level.nodes].sort(
			(a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0) || (a.order ?? 0) - (b.order ?? 0),
		);
		/** 节点高度：优先实测，没量到就按"两行标题 + 说明"估 */
		const heightOf = (id: string) => heights[id] ?? 128;
		const GAP = 22;
		const map = new Map<string, Pos>();

		if (style === "mindmap") {
			return { positions: mindmapLayout(level.nodes, level.edges, (id) => heights[id] ?? 128), bands: [] };
		}

		if (style === "timeline") {
			// 每列自己往下堆
			const cursor = new Map<number, number>();
			for (const node of ordered) {
				const depth = depths.get(node.id) ?? 0;
				const y = cursor.get(depth) ?? 64;
				map.set(node.id, { x: 40 + depth * 300, y });
				cursor.set(depth, y + heightOf(node.id) + GAP);
			}
			return { positions: map, bands: [] };
		} else {
			// 清单：一列到底，按真实高度往下排
			let y = 64;
			for (const node of ordered) {
				map.set(node.id, { x: 40, y });
				y += heightOf(node.id) + GAP;
			}
		}
		return { positions: map, bands: [] };
	}, [level, style, heights]);

	/** 派生布局的位置（卡片风格是 null，用服务端坐标） */
	const derived = layoutResult.positions;
	/** 泳道的底色带（别的样式是空数组） */
	const laneBands = layoutResult.bands;

	/**
	 * 卡片样式下的**防叠**。
	 *
	 * 服务端排坐标时只有一套固定行列间距（`ROW_HEIGHT`），它不知道卡片实际有多高；
	 * 说明写长一点，同一列的两张就摞在一起（用户 2026-11-25：「互相压到」）。
	 * 这里按**实测高度**把被压住的节点往下推：只推不改顺序、也不写回服务端，
	 * 而且推完再算一遍不会继续动（幂等），所以拖完一轮也不会跳。
	 *
	 * 一开始只认「x 完全一样」那一列，卡片被拖歪几十像素就不再避让，于是又叠上了
	 * （用户 2026-11-25 第二次：「有时还会叠加在一块」）。现在按**两张卡片的矩形真的相交**
	 * 来判：同一列互压、错开半格、上下行错位都算在内，只搬「被压在下面」的那张，
	 * 所以不会无缘无故拉出一片空白。
	 */
	const cardRelief = useMemo(() => {
		if (style !== "card" || level.nodes.length === 0) return null;
		/** 从左上往右下放：先在上面的先占位，后面的给它让路 */
		const nodes = [...level.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
		const placed: { x: number; y: number; w: number; h: number }[] = [];
		const map = new Map<string, Pos>();
		for (const node of nodes) {
			const height = heights[node.id] ?? estimateNodeHeight(node);
			let y = node.y;
			// 每轮至少跨过一张卡，最多跑「节点数 + 余量」轮就一定能停
			for (let guard = 0; guard <= nodes.length; guard += 1) {
				const clash = placed.find(
					(other) =>
						node.x < other.x + other.w &&
						node.x + NODE_WIDTH > other.x &&
						y < other.y + other.h + COLUMN_GAP &&
						y + height + COLUMN_GAP > other.y,
				);
				if (clash === undefined) break;
				y = clash.y + clash.h + COLUMN_GAP;
			}
			map.set(node.id, { x: node.x, y });
			placed.push({ x: node.x, y, w: NODE_WIDTH, h: height });
		}
		return map;
	}, [heights, level.nodes, style]);

	/**
	 * 非卡片样式下**手摆的位置**（本机，按 会话+样式 分别记）。
	 *
	 * 为什么只存本机：服务端的 x/y 只有一份，而"时间线里我想把这张挪开"是某个样式的个人偏好，
	 * 不该覆盖主数据。卡片样式仍然以服务端为准（那是这份计划的真实坐标）。
	 */
	const [moves, setMoves] = useState<Record<string, Record<string, Record<string, Pos>>>>(loadMoves);
	const styleMoves = style === "card" ? undefined : moves[conversationId ?? ""]?.[style];

	/** 节点坐标：手摆（非卡片样式） > 派生布局 > 刚松手的乐观值 > 卡片防叠 > 服务端坐标 */
	const posOf = useCallback(
		(node: CanvasNode): Pos =>
			styleMoves?.[node.id] ??
			derived?.get(node.id) ??
			pending[node.id] ??
			cardRelief?.get(node.id) ?? { x: node.x, y: node.y },
		[cardRelief, derived, pending, styleMoves],
	);
	/** 现在所有样式都能拖（以前只有卡片能拖，用户 2026-11-23 要求其他样式也能） */
	const canDrag = true;

	/**
	 * 画布上的键盘操作（都要满足：鼠标在画布上、焦点不在输入框里）。
	 *   Delete / Backspace → 删掉选中的节点
	 *   ⌘/Ctrl + A → 全选
	 *   Esc → 关菜单 / 退出重命名 / 取消选择
	 */
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!hoverRef.current) return;
			const target = event.target as HTMLElement | null;
			if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
			if (event.key === "Escape") {
				closeMenu();
				setEditing(null);
				setSelected([]);
				return;
			}
			if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A")) {
				event.preventDefault();
				// 只选**当前这一层**：钻进子计划时全选不能把主图的节点 id 也塞进来
				setSelected(level.nodes.map((node) => node.id));
				return;
			}
			if ((event.key === "Delete" || event.key === "Backspace") && selected.length > 0 && conversationId !== null) {
				event.preventDefault();
				canvasDeleteNodes(conversationId, selected, parentId ?? undefined);
				setSelected([]);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [closeMenu, conversationId, level.nodes, parentId, selected]);

	/**
	 * 快照里节点变了（agent 重画 / 加节点）之后重新量高度。
	 * 依赖 `doc?.rev`：同一个 rev 不重复量；量完把结果写进 state，连线才会跟着更新。
	 */
	const revision = doc?.rev ?? 0;
	/** 快照已经反映了新的坐标（rev 变了）→ 清掉乐观值，之后完全以服务端为准 */
	useEffect(() => {
		setPending({});
	}, [revision]);
	useLayoutEffect(() => {
		/**
		 * 量的是**完整卡片**的高度：布局（时间线 / 清单的列宽行高）要的是它。
		 * 缩略态下 `offsetHeight` 只有 34px，直接量会把布局算成一条条细缝，
		 * 所以量之前先把 `is-far` 摘掉，量完再挂回去（一进一出多一次布局，量高度本来就很少发生）。
		 */
		const root = rootRef.current;
		const wasFar = root?.classList.contains("is-far") === true;
		if (wasFar) root?.classList.remove("is-far");
		const next: Record<string, number> = {};
		for (const [id, element] of nodeElsRef.current) next[id] = element.offsetHeight;
		if (wasFar) root?.classList.add("is-far");
		if (Object.keys(next).length === 0) return;
		setHeights((current) => {
			const same =
				Object.keys(next).length === Object.keys(current).length &&
				Object.entries(next).every(([id, h]) => current[id] === h);
			return same ? current : next;
		});
	}, [revision, pending, runningNodeId, run?.status, run?.activeTool?.name, style]);

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
		/**
		 * 远距离（`FAR_K` 以下）才切「缩略」：节点里只留一个编号 + 标题。
		 * 门槛是 0.4（用户 2026-11-26 定稿）：0.4 以上完整卡片，再往下才抽成一行标题 ——
		 * 而且 `setFar` 要跟着变：连线端点用的是缩略高度，
		 * 只换 class 不换坐标的话，卡片矮了、线还挂在高处。
		 */
		const isFar = view.k < FAR_K;
		if (isFar !== farRef.current) {
			farRef.current = isFar;
			rootRef.current?.classList.toggle("is-far", isFar);
			setFar(isFar);
		}
		if (readoutRef.current) {
			readoutRef.current.textContent = `${view.k.toFixed(2)}×`;
			// x/y 挪到 title：工具栏里那一长串是最容易被压到折行的部分
			readoutRef.current.title = `x ${Math.round(view.x)} · y ${Math.round(view.y)} · ${view.k.toFixed(2)}×`;
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
		},
		[paint],
	);

	/** 以视口中心为锚缩放一档（+/− 按钮和键盘共用这一个入口） */
	const zoomBy = useCallback(
		(factor: number) => {
			const viewport = viewportRef.current;
			if (!viewport) return;
			zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, viewRef.current.k * factor);
		},
		[zoomAt],
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
	const marqueeRefState = useRef<{ id: number; sx: number; sy: number; additive: boolean; moved: boolean } | null>(
		null,
	);

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
		// 时间线 / 清单是按依赖重排出来的只读视图，拖它没有意义
		if (!canDrag) return;
		// 放大工具开着的时候，拖在节点上也应该画放大框 —— 不 stopPropagation，交给视口接管
		if (zDownRef.current || zoomArmedRef.current) return;
		if ((event.target as HTMLElement).closest("button, select")) return;
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

		/**
		 * 起点坐标必须从**当前这一层**取（`level.nodes`）。
		 * 以前这里写的是 `doc.nodes`（主图）：钻进子计划后子节点的 id 在主图里根本找不到，
		 * `origins` 是空的 → 拖动一动不动（用户 2026-11-25 报的「画布拖动不了」）。
		 */
		const origins = new Map<string, Pos>();
		for (const each of ids) {
			const node = level.nodes.find((entry) => entry.id === each);
			if (node) origins.set(each, posOf(node));
		}
		dragRef.current = {
			pointerId: event.pointerId,
			ids: [...origins.keys()],
			sx: event.clientX,
			sy: event.clientY,
			origins,
			moved: false,
		};
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
			for (const node of level.nodes) {
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
		[heights, level.nodes, posOf, showGuides],
	);

	/** 框选放大：按住 Z 拖（或点工具条按钮切成常开） */
	const [zoomArmed, setZoomArmed] = useState(false);
	const zoomArmedRef = useRef(false);
	useLayoutEffect(() => {
		zoomArmedRef.current = zoomArmed;
		// 按钮切成的常开模式也要把光标改掉，否则用户看不出現在左键拖是放大
		viewportRef.current?.classList.toggle("can-zoom", zoomArmed || zDownRef.current);
	}, [zoomArmed]);
	const zDownRef = useRef(false);
	const zoomDragRef = useRef<{ id: number; sx: number; sy: number; moved: boolean } | null>(null);

	const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (target.closest(".canvas-bar")) return;
		/**
		 * 框选放大优先于一切：它是个“工具”模式（Figma 的缩放工具 likewise），
		 * 开着的时候连节点也不拖，左键一律拉框——否则在节点上起不了手，很难用。
		 */
		if (event.button === 0 && (zDownRef.current || zoomArmedRef.current)) {
			zoomDragRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, moved: false };
			viewportRef.current?.classList.add("is-zooming");
			viewportRef.current?.setPointerCapture(event.pointerId);
			return;
		}
		if (target.closest(".canvas-node")) return;
		const wantMarquee = event.shiftKey || event.altKey;
		if (event.button === 1 || (event.button === 0 && !wantMarquee)) {
			panRef.current = {
				id: event.pointerId,
				sx: event.clientX,
				sy: event.clientY,
				ox: viewRef.current.x,
				oy: viewRef.current.y,
			};
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
		const zoomDrag = zoomDragRef.current;
		if (zoomDrag !== null && event.pointerId === zoomDrag.id) {
			const viewport = viewportRef.current;
			const box = marqueeRef.current;
			if (!viewport || !box) return;
			const rect = viewport.getBoundingClientRect();
			const x0 = zoomDrag.sx - rect.left;
			const y0 = zoomDrag.sy - rect.top;
			const x1 = event.clientX - rect.left;
			const y1 = event.clientY - rect.top;
			if (!zoomDrag.moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
			zoomDrag.moved = true;
			box.classList.add("is-zoom");
			box.style.display = "block";
			box.style.left = `${Math.min(x0, x1)}px`;
			box.style.top = `${Math.min(y0, y1)}px`;
			box.style.width = `${Math.abs(x1 - x0)}px`;
			box.style.height = `${Math.abs(y1 - y0)}px`;
			return;
		}

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
			for (const node of level.nodes) {
				const pos = posOf(node);
				const nodeHeight = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
				const overlaps =
					pos.x < worldRight && pos.x + NODE_WIDTH > worldLeft && pos.y < worldBottom && pos.y + nodeHeight > worldTop;
				if (overlaps) hits.push(node.id);
			}
			setSelected((current) => (additive ? [...new Set([...current, ...hits])] : hits));
		},
		[heights, level.nodes, posOf],
	);

	/** 把框选出来的那块屏幕矩形放大到铺满视口（框选放大） */
	const applyZoomToRect = useCallback(() => {
		const viewport = viewportRef.current;
		const box = marqueeRef.current;
		if (!viewport || !box) return;
		const view = viewRef.current;
		const left = Number.parseFloat(box.style.left) || 0;
		const top = Number.parseFloat(box.style.top) || 0;
		const width = Number.parseFloat(box.style.width) || 0;
		const height = Number.parseFloat(box.style.height) || 0;
		// 手抖拉出来的几像素小框不当作放大：那会一口气跳到 MAX_K
		if (width < 8 || height < 8) return;
		const worldWidth = width / view.k;
		const worldHeight = height / view.k;
		const worldLeft = (left - view.x) / view.k;
		const worldTop = (top - view.y) / view.k;
		const k = clampK(Math.min(viewport.clientWidth / worldWidth, viewport.clientHeight / worldHeight));
		view.k = k;
		// 把这块世界的中心对齐到视口中心
		view.x = (viewport.clientWidth - worldWidth * k) / 2 - worldLeft * k;
		view.y = (viewport.clientHeight - worldHeight * k) / 2 - worldTop * k;
		paint();
	}, [paint]);

	const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (pan !== null && event.pointerId === pan.id) {
			panRef.current = null;
			viewportRef.current?.classList.remove("is-panning");
		}

		const zoomDrag = zoomDragRef.current;
		if (zoomDrag !== null && event.pointerId === zoomDrag.id) {
			zoomDragRef.current = null;
			viewportRef.current?.classList.remove("is-zooming");
			if (zoomDrag.moved) applyZoomToRect();
			if (marqueeRef.current) {
				marqueeRef.current.style.display = "none";
				marqueeRef.current.classList.remove("is-zoom");
			}
			// 按钮模式的“用一次就收”：不然下一次左键拖还是放大，人会困惑
			if (zoomArmedRef.current) setZoomArmed(false);
			return;
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
		const moved: Record<string, Pos> = {};
		const moves: { id: string; x: number; y: number }[] = [];
		for (const [id, delta] of deltas) {
			const origin = drag.origins.get(id);
			if (!origin) continue;
			const pos = { x: origin.x + delta.x, y: origin.y + delta.y };
			moved[id] = pos;
			moves.push({ id, ...pos });
		}
		if (style === "card") {
			// 先乐观摆上（不然会闪回原位），再回写服务端；rev 一变就清 pending
			setPending((current) => ({ ...current, ...moved }));
			if (conversationId !== null) canvasMoveNodes(conversationId, moves, parentId ?? undefined);
		} else {
			// 其他样式：只记在本机（按样式分开，不污染服务端那份坐标）
			setMoves((current) => {
				const key = conversationId ?? "";
				const forStyle = { ...current[key]?.[style], ...moved };
				const next = { ...current, [key]: { ...current[key], [style]: forStyle } };
				saveMoves(next);
				return next;
			});
		}
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
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [paint, zoomAt]);

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
				zoomBy(factor);
				return;
			}
			if (event.key === "0") {
				event.preventDefault();
				zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [zoomBy, zoomAt]);

	/**
	 * 框选放大的快捷键：**按住 Z 拖框**（和 Figma 的缩放工具一个手感）。
	 * Esc 取消按钮切的那个常开模式。⌘Z 是撤销，不能抢。
	 */
	useEffect(() => {
		const isTyping = (target: EventTarget | null) => {
			const element = target as HTMLElement | null;
			return element !== null && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
		};
		const setZ = (down: boolean) => {
			zDownRef.current = down;
			viewportRef.current?.classList.toggle("can-zoom", down || zoomArmedRef.current);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (isTyping(event.target)) return;
			if ((event.key === "z" || event.key === "Z") && !event.metaKey && !event.ctrlKey && !event.altKey) {
				if (!hoverRef.current) return;
				setZ(true);
				return;
			}
			if (event.key === "Escape") {
				setZoomArmed(false);
				setZ(false);
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === "z" || event.key === "Z") setZ(false);
		};
		const onBlur = () => setZ(false);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	/**
	 * 适应内容：把所有节点的包围盒塞进视口。
	 *   `maxK`   自动算比例时的上限（菜单里的「看全局」用它，别把小图放大填满）
	 *   `exactK` 给了就不再算比例，直接按这个缩放居中 —— 首次打开固定 0.8 走这条，
	 *            否则会被 `FIT_MIN_K`（0.5）那条「别缩太小」的底线吃掉
	 */
	const fit = useCallback(
		(maxK = 1, exactK?: number) => {
			const viewport = viewportRef.current;
			if (!viewport) return;
			if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
			const fitNodes = level.nodes;
			if (fitNodes.length === 0) return;
			let minX = Number.POSITIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const node of fitNodes) {
				const pos = posOf(node);
				const height = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
				minX = Math.min(minX, pos.x);
				minY = Math.min(minY, pos.y);
				maxX = Math.max(maxX, pos.x + NODE_WIDTH);
				maxY = Math.max(maxY, pos.y + height);
			}
			const pad = 40;
			/**
			 * 上限 1（只有两个节点时不要按比例"放大填满"）、下限到 `FIT_MIN_K`。
			 *
			 * 以前这里一路缩到 MIN_K（0.2），节点一多就沦为一堆读不出字的小方块
			 * （用户 2026-11-25：「全局缩小时不要太小」）。现在宁可装不下、靠平移补，
			 * 也不把字缩到看不见 —— 装下的部分居中，装不下的靠左上。
			 */
			const autoK = Math.min(
				maxK,
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
			// exactK 是「就按这个比例」，不走自动算的那套下限
			const k = exactK === undefined ? autoK : clampK(exactK);
			viewRef.current.k = k;
			// 装得下就居中；装不下就靠左上（否则"居中"会把最左边那排推到屏幕外）
			const centeredX = (viewport.clientWidth - (maxX - minX) * k) / 2 - minX * k;
			const centeredY = (viewport.clientHeight - (maxY - minY) * k) / 2 - minY * k;
			viewRef.current.x = Math.max(centeredX, pad - minX * k);
			viewRef.current.y = Math.max(centeredY, pad - minY * k);
			paint();
		},
		[heights, level.nodes, paint, posOf],
	);

	const reset = useCallback(() => {
		viewRef.current = { x: 0, y: 0, k: 1 };
		paint();
	}, [paint]);

	/**
	 * **只把画布全屏**（用户 2026-11-26：「我是要只画布全屏，放到画布里的这个里面」）。
	 *
	 * 用的是元素级 Fullscreen API（对 `rootRef` 这个画布节点），不是整页那套：
	 * 整页全屏会把侧栏和对话一起留下，而这里要的是"这张图占满屏幕、其余全让开"。
	 * 顺便白拿两件事：一个系统级的退出出口（Esc），以及不会踩到祖先 `transform` 的定位坑
	 * （`position: fixed` 那种做法一旦上层的某个祖先有 transform 就会错位）。
	 */
	const [canvasFull, setCanvasFull] = useState(false);
	const toggleCanvasFullscreen = useCallback(() => {
		const element = rootRef.current;
		if (element === null) return;
		if (document.fullscreenElement === element) {
			void document.exitFullscreen?.().catch(() => undefined);
			return;
		}
		void element.requestFullscreen?.({ navigationUI: "hide" }).catch(() => undefined);
	}, []);
	useEffect(() => {
		const onChange = () => {
			setCanvasFull(document.fullscreenElement === rootRef.current);
			// 进出全屏视口尺寸都变了：重排一次，否则连线端点还是按旧尺寸算的
			paint();
			setHover(null);
		};
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, [paint]);

	/**
	 * 第一次打开这张画布时先缩到 0.8。
	 *
	 * 1:1 打开时一张卡 240px 宽、整张图通常比视口还大，第一眼看到的就是「卡片挤成一堆」
	 * （用户 2026-11-26：「默认打开时可以缩放 0.8 吧」）。只在**这张画布第一次开**时做一次，
	 * 之后视图归用户；换会话 / 钻进子计划算新的一张。
	 */
	const openKey = `${conversationId ?? ""}|${parentId ?? ""}`;
	const openedRef = useRef<string | null>(null);
	useEffect(() => {
		if (openedRef.current === openKey) return;
		const viewport = viewportRef.current;
		// 右栏收起来 / 切到别的标签时视口是 0，这时候 fit 算出来全是 NaN，等它真的显示出来再算
		if (viewport === null || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
		// 等实测高度回来再算，否则按估算高度居中，量完会跳一下
		if (level.nodes.length === 0) return;
		if (!level.nodes.every((node) => heights[node.id] !== undefined)) return;
		openedRef.current = openKey;
		fit(0.8, 0.8);
	}, [fit, heights, level.nodes, openKey]);

	/** 重命名提交：标题不能为空，说明可以清空 */
	const commitEditing = useCallback(() => {
		const draft = editingRef.current;
		setEditing(null);
		if (draft === null || conversationId === null) return;
		const node = level.nodes.find((each) => each.id === draft.id);
		if (node === undefined) return;
		const title = draft.title.trim();
		const detail = draft.detail.trim();
		const patch: { title?: string; detail?: string } = {};
		if (title !== "" && title !== node.title) patch.title = title;
		if (detail !== (node.detail ?? "")) patch.detail = detail;
		if (patch.title !== undefined || patch.detail !== undefined)
			canvasUpdateNode(conversationId, draft.id, patch, parentId ?? undefined);
	}, [conversationId, level.nodes, parentId]);

	/** 右边菜单 / 内联编辑要用的"当前编辑值"，提交时不想因为闭包拿不到最新值 */
	const editingRef = useRef<{ id: string; title: string; detail: string } | null>(null);
	useLayoutEffect(() => {
		editingRef.current = editing;
	}, [editing]);

	/** 拉一批候选指令（打开输入框时自动拉，「换一批」也走它） */
	const loadSuggestions = useCallback(async () => {
		if (ask === null || conversationId === null) return;
		setSuggesting(true);
		try {
			const list = await canvasSuggest(conversationId, ask.nodeIds, parentId ?? undefined);
			setSuggestions(list);
		} finally {
			setSuggesting(false);
		}
	}, [ask, conversationId, parentId]);

	useEffect(() => {
		if (ask === null) {
			setSuggestions([]);
			return;
		}
		void loadSuggestions();
		// 只在"打开输入框"时拉一次；ask.text 变化不该反复打模型
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ask?.nodeIds.join(","), ask !== null]);

	/** 把「选区 + 我的要求」拼成一条消息发给 agent */
	const sendAsk = useCallback(() => {
		if (ask === null || conversationId === null) return;
		const picked = ask.nodeIds
			.map((id) => level.nodes.find((node) => node.id === id))
			.filter((node): node is CanvasNode => node !== undefined);
		const requirement = ask.text.trim();
		if (picked.length === 0 || requirement === "") return;
		const lines = [
			`【画布选区】针对这 ${picked.length} 个节点：`,
			...picked.map(
				(node) =>
					`- ${node.id}（${node.status}${node.kind ? `，${node.kind}` : ""}）：${node.title}${node.detail ? ` —— ${node.detail}` : ""}`,
			),
			"",
			`我的要求：${requirement}`,
			"",
			"只改这几个节点（用 canvas 工具的 update / status / add 定位到上面的 id），别动其他节点；改完一句话说改了什么。",
		];
		// 发出去就是下一段了：上一条回复的朗读别接着响（同回车发送）
		requestInterruptSpeech();
		sendMessage(lines.join("\n"));
		setAsk(null);
	}, [ask, conversationId, level.nodes]);

	/** 手改节点状态（服务端落盘 + 推快照，这里不做乐观更新：一次往返很快） */
	const setNodeStatus = useCallback(
		(node: CanvasNode, status: CanvasNodeStatus) => {
			if (conversationId === null || status === node.status) return;
			canvasSetStatus(conversationId, node.id, status, parentId ?? undefined);
		},
		[conversationId, parentId],
	);

	/** 删一个节点（连带它上面的线由服务端处理） */
	const deleteNode = useCallback(
		(node: CanvasNode) => {
			if (conversationId === null) return;
			canvasDeleteNodes(conversationId, [node.id], parentId ?? undefined);
			setSelected((current) => current.filter((id) => id !== node.id));
			setHover((current) => (current?.id === node.id ? null : current));
		},
		[conversationId],
	);

	/** 产出清单（预览卡和「N 项产出」弹层共用一份） */
	const renderArtifacts = useCallback(
		(node: CanvasNode) => {
			const list = node.artifacts ?? [];
			if (list.length === 0) return null;
			return (
				<div className="canvas-preview-artifacts">
					<div className="canvas-preview-artifacts-head">{t("这一步的产出", "Artifacts")}</div>
					{list.map((artifact, index) => {
						const canOpen = artifact.kind === "file" && artifact.detail !== "工作区外";
						return (
							<button
								type="button"
								key={`${artifact.kind}-${index}-${artifact.label}`}
								className={`canvas-artifact is-${artifact.kind}${canOpen ? " can-open" : ""}`}
								title={artifact.detail ?? artifact.label}
								onClick={() => {
									if (canOpen) {
										onOpenFile(artifact.label);
										setArtifactsOf(null);
									}
								}}
							>
								<span className="canvas-artifact-icon">
									{artifact.kind === "file" ? "▤" : artifact.kind === "command" ? ">_" : "✎"}
								</span>
								<span className="canvas-artifact-label">{artifact.label}</span>
								{artifact.detail ? <span className="canvas-artifact-detail">{artifact.detail}</span> : null}
							</button>
						);
					})}
				</div>
			);
		},
		[t, onOpenFile],
	);

	/**
	 * 双击节点 = 让 agent 开始做这一步。
	 *
	 * 交给宿主的 `canvas_start_node`，而不是自己发一句话：宿主会把它标成「正在做」，
	 * 并记住这一轮干的是哪个节点，回合结束自动推到 done（失败则 blocked）。
	 */
	const startNode = useCallback(
		(node: CanvasNode) => {
			if (conversationId === null) return;
			canvasStartNode(conversationId, node.id, parentId ?? undefined);
		},
		[conversationId],
	);

	const nodes = level.nodes;
	const chosen = useMemo(() => new Set(selected), [selected]);

	/** 悬停的节点（缩得很小时弹一张不缩放的预览卡，否则字永远看不清） */
	const [hover, setHover] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
	const hoverNode = hover === null ? null : (nodes.find((node) => node.id === hover.id) ?? null);
	/**
	 * 鼠标从节点移到预览卡上时，节点的 pointerleave 会先把卡清掉 —— 那就点不到「放大看」了。
	 * 所以离场不是立刻清，而是挂一个短延时；进到卡上就取消它。
	 */
	const hoverTimer = useRef<number | null>(null);
	const keepHover = useCallback(() => {
		if (hoverTimer.current !== null) {
			window.clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
	}, []);
	const dropHover = useCallback(() => {
		keepHover();
		setHover(null);
	}, [keepHover]);
	const scheduleDropHover = useCallback(() => {
		keepHover();
		hoverTimer.current = window.setTimeout(() => {
			hoverTimer.current = null;
			setHover(null);
		}, 160);
	}, [keepHover]);

	/** 把一个节点放大到铺满视口（预览卡上的「放大」按钮） */
	const zoomToNode = useCallback(
		(node: CanvasNode) => {
			const viewport = viewportRef.current;
			if (!viewport) return;
			const pos = posOf(node);
			const height = nodeElsRef.current.get(node.id)?.offsetHeight ?? heights[node.id] ?? 84;
			const pad = 60;
			const k = clampK(
				Math.min(
					(viewport.clientWidth - pad * 2) / NODE_WIDTH,
					(viewport.clientHeight - pad * 2) / Math.max(1, height),
				),
			);
			viewRef.current.k = k;
			viewRef.current.x = viewport.clientWidth / 2 - (pos.x + NODE_WIDTH / 2) * k;
			viewRef.current.y = viewport.clientHeight / 2 - (pos.y + height / 2) * k;
			paint();
			setHover(null);
		},
		[heights, paint, posOf],
	);

	/** 预览卡的位置：优先放节点右侧，右侧放不下就翻到左侧；纵向夹在视口内 */
	const previewLayout = useMemo(() => {
		if (hover === null) return null;
		const width = 300;
		const viewportWidth = viewportRef.current?.clientWidth ?? 600;
		const viewportHeight = viewportRef.current?.clientHeight ?? 600;
		const left =
			hover.x + hover.w + 12 + width > viewportWidth ? Math.max(8, hover.x - width - 12) : hover.x + hover.w + 12;
		const top = Math.max(8, Math.min(hover.y, viewportHeight - 170));
		return { left, top, width };
	}, [hover]);

	/** 连线：从源节点右边中点到目标节点左边中点的一条曲线 */
	const edges = useMemo(() => {
		if (doc === null || level.edges.length === 0) return [];
		const posById = new Map(level.nodes.map((node) => [node.id, posOf(node)]));
		const heightById = new Map(
			level.nodes.map((node) => [node.id, far ? FAR_NODE_HEIGHT : (heights[node.id] ?? 84)]),
		);
		const statusById = new Map(level.nodes.map((node) => [node.id, node.status]));
		/**
		 * 同一个节点出去的线、进来的线各占一个纵向位置。
		 *
		 * 不分开的话所有线从卡片右侧**同一个点**出发，看上去就是一根灰线分叉，
		 * 根本数不出这是几条依赖（用户 2026-11-26：「连线可以区分一下」）。
		 */
		const outCount = new Map<string, number>();
		const inCount = new Map<string, number>();
		for (const edge of level.edges) {
			outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
			inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1);
		}
		const outSeen = new Map<string, number>();
		const inSeen = new Map<string, number>();
		/** 第 index 条（共 count 条）在卡片侧边上的落点：均分、上下对称，别超出上下圆角 */
		const portOffset = (index: number, count: number, height: number) => {
			if (count <= 1) return 0;
			const usable = Math.max(0, height - 26);
			return (index - (count - 1) / 2) * Math.min(16, usable / (count - 1));
		};
		return level.edges
			.map((edge) => {
				const from = posById.get(edge.from);
				const to = posById.get(edge.to);
				if (!from || !to) return null;
				/**
				 * 连线的颜色跟着**下游**走：这条依赖是为下游服务的，下游什么状态它就是什么状态。
				 *   done    下游已完成 → 这条路走完了
				 *   active  上游已完成 + 下游正在做 → 正在走的那一段
				 *   blocked 下游卡住 → 琥珀色虚线
				 *   idle    还没轮到 → 压暗，别和主线抢眼（十几条线一样亮就是一团灰）
				 */
				const fromStatus = statusById.get(edge.from) ?? "todo";
				const toStatus = statusById.get(edge.to) ?? "todo";
				const fromHeight = heightById.get(edge.from) ?? 84;
				const toHeight = heightById.get(edge.to) ?? 84;
				// 这一条是这个节点伸出去 / 接进来的第几条（按 level.edges 顺序，稳定）
				const outIndex = outSeen.get(edge.from) ?? 0;
				outSeen.set(edge.from, outIndex + 1);
				const inIndex = inSeen.get(edge.to) ?? 0;
				inSeen.set(edge.to, inIndex + 1);
				const tone =
					toStatus === "done"
						? "done"
						: toStatus === "blocked"
							? "blocked"
							: toStatus === "doing" && fromStatus === "done"
								? "active"
								: "idle";
				const x1 = from.x + NODE_WIDTH;
				const y1 = from.y + fromHeight / 2 + portOffset(outIndex, outCount.get(edge.from) ?? 1, fromHeight);
				const x2 = to.x;
				const y2 = to.y + toHeight / 2 + portOffset(inIndex, inCount.get(edge.to) ?? 1, toHeight);
				// 目标在左边时（用户可能把节点拖乱了）从源节点左侧出，别画一条横穿整张图的线
				const backwards = x2 < x1;
				const sx = backwards ? from.x : x1;
				const ex = backwards ? to.x + NODE_WIDTH : x2;
				/**
				 * 收一点点，把箭头留在卡片外面。
				 * 不收回来的话箭头尖会顶在卡片边框上、一半压在字上，反而更像"接错了"。
				 */
				const tip = backwards ? ex + ARROW_GAP : ex - ARROW_GAP;
				const bend = Math.max(48, Math.abs(tip - sx) * 0.45) * (backwards ? -1 : 1);
				const d = `M ${sx} ${y1} C ${sx + bend} ${y1}, ${tip - bend} ${y2}, ${tip} ${y2}`;
				return {
					key: `${edge.from}->${edge.to}`,
					d,
					label: edge.label,
					tone,
					mid: { x: (sx + ex) / 2, y: (y1 + y2) / 2 },
				};
			})
			.filter(
				(edge): edge is { key: string; d: string; label: string | undefined; tone: string; mid: Pos } => edge !== null,
			);
	}, [doc, level, heights, far, posOf]);

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
				onContextMenu={(event) => {
					// 点在节点上的已经 stopPropagation 了，能冒到这儿的就是空白区
					event.preventDefault();
					setMenu(openMenuAt(event));
				}}
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
					{/* 泳道底色带：在节点和连线下面，标出"这一摊事" */}
					{laneBands.map((band) => (
						<div
							className="canvas-lane"
							key={`${band.label}-${band.y}`}
							style={{ left: band.x, top: band.y, width: band.w, height: band.h }}
						>
							<span className="canvas-lane-label">{band.label}</span>
						</div>
					))}
					{/* 连线画在世界坐标系里，跟着一起缩放 */}
					{edges.length > 0 ? (
						<svg className="canvas-edges">
							{/*
							 * 方向箭头：只要一个瘦瘦的 V，跟着线自己的颜色走。
							 * 没有它的时候，弯线从卡片右侧出发绕到下一张，看着像"接反了"
							 * （用户 2026-11-26：「带上一个小箭头我看看方向，不要太明显」）。
							 */}
							<defs>
								{(["idle", "active", "done", "blocked"] as const).map((tone) => (
									<marker
										key={tone}
										id={`canvas-arrow-${tone}`}
										className={`canvas-arrow is-${tone}`}
										viewBox="0 0 8 8"
										refX="6.4"
										refY="4"
										markerWidth="4.6"
										markerHeight="4.6"
										orient="auto"
									>
										<path d="M 1.6 1.4 L 6.4 4 L 1.6 6.6" />
									</marker>
								))}
							</defs>
							{edges.map((edge) => (
								<path
									key={edge.key}
									className={`is-${edge.tone}`}
									d={edge.d}
									markerEnd={`url(#canvas-arrow-${edge.tone})`}
								/>
							))}
						</svg>
					) : null}
					{nodes.map((node, index) => {
						const pos = posOf(node);
						const state = statusOf(node);
						const isSelected = chosen.has(node.id);
						/** 这一轮正在干的就是它：把「跑到哪了」直接写在节点上 */
						const isLive = runningNodeId === node.id && run !== undefined && run.status !== "idle";
						const liveText = isLive ? describeRun(run, t) : null;
						return (
							<div
								className={`canvas-node is-${state.tone} kind-${kindOf(node)}${isSelected ? " is-selected" : ""}${isLive ? " is-live" : ""}`}
								key={node.id}
								ref={(element) => {
									if (element) nodeElsRef.current.set(node.id, element);
									else nodeElsRef.current.delete(node.id);
								}}
								style={{ left: pos.x, top: pos.y }}
								onPointerDown={(event) => onNodePointerDown(event, node.id)}
								onContextMenu={(event) => {
									event.preventDefault();
									event.stopPropagation();
									setMenu(openMenuAt(event, node.id));
								}}
								onPointerEnter={() => {
									// 只在小尺度（已切缩略）时弹预览：放大到看得清的时候弹反而是干扰
									if (viewRef.current.k >= FAR_K) {
										setHover(null);
										return;
									}
									const view = viewRef.current;
									const height = nodeElsRef.current.get(node.id)?.offsetHeight ?? 84;
									setHover({
										id: node.id,
										x: pos.x * view.k + view.x,
										y: pos.y * view.k + view.y,
										w: NODE_WIDTH * view.k,
										h: height * view.k,
									});
								}}
								onPointerLeave={scheduleDropHover}
								onDoubleClick={() => {
									// 有子计划 → 钻进去看；没有 → 还是"开始做这一步"
									if (node.sub !== undefined) setPath([node.id]);
									else startNode(node);
								}}
								title={t("双击让 agent 开始做这一步", "Double-click to have the agent start this step")}
							>
								{/* 缩略时的顺序号：标题也一起留在卡上（见 canvas.css 的 is-far 那一段），编号负责对顺序 */}
								<span className="canvas-node-index">{index + 1}</span>
								{editing !== null && editing.id === node.id ? (
									/* 重命名：标题一行输入 + 说明多行输入，Enter 保存 / Esc 取消 */
									<div className="canvas-node-edit">
										<input
											className="canvas-node-edit-title"
											value={editing.title}
											autoFocus
											onChange={(event) => setEditing({ ...editing, title: event.target.value })}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.preventDefault();
													commitEditing();
												}
												if (event.key === "Escape") setEditing(null);
											}}
										/>
										<textarea
											className="canvas-node-edit-detail"
											value={editing.detail}
											rows={2}
											placeholder={t("说明（可留空）", "Detail (optional)")}
											onChange={(event) => setEditing({ ...editing, detail: event.target.value })}
											onKeyDown={(event) => {
												if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
													event.preventDefault();
													commitEditing();
												}
												if (event.key === "Escape") setEditing(null);
											}}
										/>
										<div className="canvas-node-edit-actions">
											<button type="button" onClick={commitEditing}>
												{t("保存", "Save")}
											</button>
											<button type="button" onClick={() => setEditing(null)}>
												{t("取消", "Cancel")}
											</button>
										</div>
									</div>
								) : (
									<>
										<div className="canvas-node-head">
											<span className={`canvas-dot is-${state.tone}`} />
											<span
												className={`canvas-node-kind kind-${kindOf(node)}`}
												title={t(KIND_META[kindOf(node)].zh, KIND_META[kindOf(node)].en)}
											>
												{KIND_META[kindOf(node)].icon}
											</span>
											<span className="canvas-node-title">{node.title}</span>
										</div>
										{node.detail ? <div className="canvas-node-detail">{node.detail}</div> : null}
									</>
								)}
								{isLive && liveText !== null ? (
									<div className="canvas-node-live">
										<span className="canvas-live-dot" />
										<span className="canvas-live-text">{liveText}</span>
									</div>
								) : null}
								<div className={`canvas-node-state is-${state.tone}`}>
									{t(state.zh, state.en)}
									{node.sub !== undefined && node.sub.nodes.length > 0 ? (
										<button
											type="button"
											className="canvas-node-sub"
											title={t("看这一步的子计划", "Open its sub-plan")}
											onPointerDown={(event) => event.stopPropagation()}
											onClick={() => setPath([node.id])}
										>
											· {node.sub.nodes.filter((each) => each.status === "done").length}/{node.sub.nodes.length}{" "}
											{t("子步", "sub")}
										</button>
									) : null}
									{node.artifacts !== undefined && node.artifacts.length > 0 ? (
										<button
											type="button"
											className="canvas-node-artifacts"
											title={t("看这一步的产出", "See artifacts")}
											onPointerDown={(event) => event.stopPropagation()}
											onClick={() => {
												const view = viewRef.current;
												setArtifactsOf({
													id: node.id,
													x: pos.x * view.k + view.x,
													y: (pos.y + 40) * view.k + view.y,
												});
											}}
										>
											· {node.artifacts.length} {t("项产出", "artifacts")}
										</button>
									) : null}
								</div>
							</div>
						);
					})}
				</div>
				<div className="canvas-marquee" ref={marqueeRef} />
				<div className="canvas-guide canvas-guide-x" ref={guideXRef} />
				<div className="canvas-guide canvas-guide-y" ref={guideYRef} />
			</div>
			{/* 悬停预览：**不在世界里**，所以不会被缩放 —— 缩到 0.36 时它是唯一能看清字的入口 */}
			{hover !== null && hoverNode !== null && previewLayout !== null ? (
				<div
					className={`canvas-preview is-${statusOf(hoverNode).tone}`}
					style={{ left: previewLayout.left, top: previewLayout.top, width: previewLayout.width }}
					onPointerEnter={keepHover}
					onPointerLeave={dropHover}
				>
					<div className="canvas-preview-head">
						<span className={`canvas-dot is-${statusOf(hoverNode).tone}`} />
						<span className="canvas-preview-title">{hoverNode.title}</span>
					</div>
					{hoverNode.detail ? <div className="canvas-preview-detail">{hoverNode.detail}</div> : null}
					{renderArtifacts(hoverNode)}

					<div className="canvas-preview-foot">
						<span className={`canvas-node-state is-${statusOf(hoverNode).tone}`}>
							{t(statusOf(hoverNode).zh, statusOf(hoverNode).en)}
						</span>
						<button type="button" className="canvas-preview-zoom" onClick={() => zoomToNode(hoverNode)}>
							{t("放大看", "Zoom in")}
						</button>
					</div>
				</div>
			) : null}
			{/* 「N 项产出」弹层 */}
			{artifactsOf !== null
				? (() => {
						const node = nodes.find((each) => each.id === artifactsOf.id);
						if (node === undefined) return null;
						return (
							<>
								<div className="canvas-menu-backdrop" onPointerDown={() => setArtifactsOf(null)} />
								<div
									className="canvas-ask"
									style={{
										left: Math.min(artifactsOf.x, (viewportRef.current?.clientWidth ?? 600) - 300),
										top: Math.min(artifactsOf.y, (viewportRef.current?.clientHeight ?? 600) - 160),
									}}
								>
									<div className="canvas-ask-head">{node.title}</div>
									{renderArtifacts(node)}
								</div>
							</>
						);
					})()
				: null}
			{/* 「就这几步说两句」：一个小输入框，正文里带上节点 id 和现状发给 agent */}
			{ask !== null ? (
				<>
					<div className="canvas-menu-backdrop" onPointerDown={() => setAsk(null)} />
					<div
						className="canvas-ask"
						style={{
							left: Math.min(ask.x, (viewportRef.current?.clientWidth ?? 600) - 300),
							top: Math.min(ask.y, (viewportRef.current?.clientHeight ?? 600) - 150),
						}}
					>
						<div className="canvas-ask-head">
							<span>{t(`对这 ${ask.nodeIds.length} 步说：`, `About these ${ask.nodeIds.length}:`)}</span>
							<button
								type="button"
								className="canvas-ask-refresh"
								disabled={suggesting}
								onClick={() => void loadSuggestions()}
							>
								{suggesting ? t("正在想…", "Thinking…") : t("换一批", "Shuffle")}
							</button>
						</div>
						{/* 候选指令：不想自己打字就点一条（也是提示"能说什么"） */}
						{suggestions.length > 0 ? (
							<div className="canvas-ask-chips">
								{suggestions.map((text) => (
									<button
										type="button"
										key={text}
										className="canvas-ask-chip"
										onClick={() => setAsk((current) => (current === null ? current : { ...current, text }))}
									>
										{text}
									</button>
								))}
							</div>
						) : null}
						<textarea
							className="canvas-ask-input"
							value={ask.text}
							autoFocus
							rows={3}
							placeholder={t(
								"比如：这几步太粗，拆细一点 / 合并成一步 / 顺序不对",
								"e.g. too coarse — split them / merge / wrong order",
							)}
							onChange={(event) => setAsk({ ...ask, text: event.target.value })}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									sendAsk();
								}
								if (event.key === "Escape") setAsk(null);
							}}
						/>
						<div className="canvas-ask-actions">
							<button type="button" className="is-primary" onClick={sendAsk}>
								{t("发给 agent", "Send")}
							</button>
							<button type="button" onClick={() => setAsk(null)}>
								{t("取消", "Cancel")}
							</button>
						</div>
					</div>
				</>
			) : null}
			{/* 右键菜单：点空白和点节点是两套项 */}
			{menu !== null ? (
				<>
					<div
						className="canvas-menu-backdrop"
						onPointerDown={closeMenu}
						onContextMenu={(event) => {
							event.preventDefault();
							closeMenu();
						}}
					/>
					{/* 右键落点标示：一个扩散的圈，让人看清自己到底点在哪儿 */}
					<span
						key={`${menu.x}-${menu.y}`}
						className="canvas-rt-marker"
						style={{ left: menu.x, top: menu.y }}
						aria-hidden="true"
					/>
					<div
						className={`canvas-menu${menuBox?.flipX ? " is-flip-x" : ""}${menuBox?.flipY ? " is-flip-y" : ""}`}
						ref={menuElRef}
						style={{
							// 落点是上面那个 effect **量出来**的：装不下就往左上翻，小三角跟着翻过去
							left: menuBox?.left ?? menu.x,
							top: menuBox?.top ?? menu.y,
							// 还没量到就先藏着，别让人看到它先闪一下再跳位置
							visibility: menuBox === null ? "hidden" : "visible",
						}}
					>
						{menu.nodeId === null ? (
							<>
								<button
									type="button"
									className="canvas-menu-item"
									onClick={() => {
										closeMenu();
										fit();
									}}
								>
									{t("看全局", "Fit all")}
								</button>
								<button
									type="button"
									className="canvas-menu-item"
									onClick={() => {
										closeMenu();
										reset();
									}}
								>
									{t("回到 100%", "Back to 100%")}
								</button>
								<button
									type="button"
									className={`canvas-menu-item${zoomArmed ? " is-on" : ""}`}
									onClick={() => {
										closeMenu();
										setZoomArmed((value) => !value);
									}}
								>
									{zoomArmed ? "✓ " : ""}
									{t("框选放大", "Zoom to area")}
								</button>
								{selected.length > 0 ? (
									<>
										<div className="canvas-menu-sep" />
										<button
											type="button"
											className="canvas-menu-item is-accent"
											onClick={() => {
												setAsk({ x: menu.x, y: menu.y, nodeIds: [...selected], text: "" });
												closeMenu();
											}}
										>
											{t(`就这 ${selected.length} 步说两句…`, `Ask about these ${selected.length}…`)}
										</button>
									</>
								) : null}
								<div className="canvas-menu-sep" />
								<div className="canvas-menu-label">{t("布局", "Layout")}</div>
								{(
									[
										["card", t("卡片", "Cards")],
										["timeline", t("时间线", "Timeline")],
										["checklist", t("清单", "Checklist")],
										["mindmap", t("导图", "Mind map")],
										["swimlane", t("泳道", "Swimlanes")],
									] as [LayoutStyle, string][]
								).map(([value, label]) => (
									<button
										type="button"
										key={value}
										className={`canvas-menu-item${style === value ? " is-on" : ""}`}
										onClick={() => {
											closeMenu();
											changeStyle(value);
										}}
									>
										{style === value ? "✓ " : ""}
										{label}
									</button>
								))}
							</>
						) : null}
						{menu.nodeId !== null
							? (() => {
									const node = nodes.find((each) => each.id === menu.nodeId);
									if (node === undefined) return null;
									const padreHint = (() => {
										const parents = level.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
										if (parents.length === 0) return null;
										const pending = parents.filter(
											(id) => (nodes.find((each) => each.id === id)?.status ?? "todo") !== "done",
										);
										if (pending.length === 0) return null;
										return t(`前置还有 ${pending.length} 步没完成`, `${pending.length} earlier step(s) not done yet`);
									})();
									return (
										<>
											<button
												type="button"
												className="canvas-menu-item is-accent"
												onClick={() => {
													// 右键的那个节点在选区里就带整个选区，否则只带它自己
													const picked = selected.includes(node.id) && selected.length > 0 ? selected : [node.id];
													setAsk({ x: menu.x, y: menu.y, nodeIds: picked, text: "" });
													closeMenu();
												}}
											>
												{selected.includes(node.id) && selected.length > 1
													? t(`就这 ${selected.length} 步说两句…`, `Ask about these ${selected.length}…`)
													: t("就这一步说两句…", "Ask about this step…")}
											</button>
											{/* 文案跟状态走：已完成的还写"开始做"就是骗人 */}
											<button
												type="button"
												className="canvas-menu-item"
												onClick={() => {
													closeMenu();
													startNode(node);
												}}
											>
												{node.status === "done"
													? t("重新做一遍", "Run it again")
													: node.status === "doing"
														? t("重新开始这一步", "Restart this step")
														: node.status === "blocked"
															? t("重试这一步", "Retry this step")
															: t("开始做这一步", "Start this step")}
											</button>
											{node.status === "doing" ? (
												<button
													type="button"
													className="canvas-menu-item"
													onClick={() => {
														closeMenu();
														if (conversationId !== null) interrupt(conversationId);
													}}
												>
													{t("停下来", "Stop it")}
												</button>
											) : null}
											{/* 前置没做完就开工：允许（有时就是要跳），但得说一声 */}
											{padreHint !== null ? <div className="canvas-menu-hint">{padreHint}</div> : null}
											<div className="canvas-menu-sep" />
											<div className="canvas-menu-label">{t("状态", "Status")}</div>
											{(
												[
													["todo", t("待办", "To do")],
													["doing", t("正在做", "Doing")],
													["done", t("已完成", "Done")],
													["blocked", t("卡住了", "Blocked")],
												] as [CanvasNodeStatus, string][]
											).map(([value, label]) => (
												<button
													type="button"
													key={value}
													className={`canvas-menu-item${node.status === value ? " is-on" : ""}`}
													onClick={() => {
														closeMenu();
														setNodeStatus(node, value);
													}}
												>
													{node.status === value ? "✓ " : ""}
													{label}
												</button>
											))}
											<div className="canvas-menu-sep" />
											<button
												type="button"
												className="canvas-menu-item"
												onClick={() => {
													closeMenu();
													setEditing({ id: node.id, title: node.title, detail: node.detail ?? "" });
												}}
											>
												{t("重命名 / 改说明", "Rename")}
											</button>
											<button
												type="button"
												className="canvas-menu-item"
												onClick={() => {
													closeMenu();
													zoomToNode(node);
												}}
											>
												{t("放大看这一步", "Zoom in")}
											</button>
											<div className="canvas-menu-sep" />
											<button
												type="button"
												className="canvas-menu-item is-danger"
												onClick={() => {
													closeMenu();
													deleteNode(node);
												}}
											>
												{t("删除这一步", "Delete")}
											</button>
										</>
									);
								})()
							: null}
					</div>
				</>
			) : null}
			<div className="canvas-bar">
				{/* 钻进子计划时：面包屑直接放工具条里（独立浮层会挡住第一个节点） */}
				{parentId !== null ? (
					<span className="canvas-crumbs">
						<button type="button" onClick={() => setPath([])} title={t("回到全部", "Back to all")}>
							‹ {t("全部", "All")}
						</button>
						<span className="canvas-crumbs-sep">›</span>
						<span className="canvas-crumbs-current">{level.host?.title ?? parentId}</span>
					</span>
				) : null}
				{/* 图标按钮：面板窄的时候文字会折成竖排单字，图标 + title 更稳 */}
				<button
					type="button"
					className="canvas-icon-btn"
					onClick={() => fit()}
					title={t("看全局（尽量都装下；装不下就平移看）", "Fit all (as much as stays readable; pan for the rest)")}
					aria-label={t("看全局", "Fit all")}
				>
					<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
						<path
							d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				</button>
				<button
					type="button"
					className="canvas-icon-btn canvas-icon-text"
					onClick={reset}
					title={t("回到 100%（重置视角）", "Back to 100%")}
					aria-label={t("重置视角", "Reset view")}
				>
					1:1
				</button>
				{/*
				 * 画布全屏 / 退出全屏。图标刻意跟左边那颗「看全局」区分开：
				 * 那颗是四个角括号（装下全部），这颗是**对角双箭头**（铺满整屏）。
				 */}
				{typeof document !== "undefined" && document.fullscreenEnabled ? (
					<button
						type="button"
						className={`canvas-icon-btn${canvasFull ? " is-on" : ""}`}
						onClick={toggleCanvasFullscreen}
						aria-pressed={canvasFull}
						title={canvasFull ? t("退出全屏（Esc）", "Exit full screen (Esc)") : t("画布全屏", "Full screen canvas")}
						aria-label={canvasFull ? t("退出全屏", "Exit full screen") : t("画布全屏", "Full screen canvas")}
					>
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							{canvasFull ? (
								<path
									d="M6.2 2.6v3.6H2.6M9.8 2.6v3.6h3.6M6.2 13.4v-3.6H2.6M9.8 13.4v-3.6h3.6"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.4"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							) : (
								<path
									d="M2.6 6.2V2.6h3.6M13.4 6.2V2.6H9.8M2.6 9.8v3.6h3.6M13.4 9.8v3.6H9.8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.4"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							)}
						</svg>
					</button>
				) : null}
				<select
					className="canvas-style"
					value={style}
					aria-label={t("画布布局", "Canvas layout")}
					title={t("画布布局", "Canvas layout")}
					onChange={(event) => changeStyle(event.target.value as LayoutStyle)}
				>
					<option value="card">{t("卡片", "Cards")}</option>
					<option value="timeline">{t("时间线", "Timeline")}</option>
					<option value="checklist">{t("清单", "Checklist")}</option>
					<option value="mindmap">{t("导图", "Mind map")}</option>
					<option value="swimlane">{t("泳道", "Swimlanes")}</option>
				</select>
				<button
					type="button"
					className={`canvas-icon-btn${zoomArmed ? " is-on" : ""}`}
					aria-pressed={zoomArmed}
					onClick={() => setZoomArmed((value) => !value)}
					title={t("框选放大（也可以按住 Z 拖）", "Zoom to area")}
					aria-label={t("框选放大", "Zoom to area")}
				>
					<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
						<rect
							x="1.5"
							y="1.5"
							width="8"
							height="8"
							rx="1"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							strokeDasharray="2 1.6"
						/>
						<circle cx="10.6" cy="10.6" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
						<path d="M12.9 12.9 15 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					</svg>
				</button>
				{/* 缩放按钮：和键盘 +/- 、触摸板捏合走同一个 zoomBy */}
				<span className="canvas-zoom">
					<button
						type="button"
						onClick={() => zoomBy(1 / 1.15)}
						title={t("缩小", "Zoom out")}
						aria-label={t("缩小", "Zoom out")}
					>
						−
					</button>
					<button
						type="button"
						onClick={() => zoomBy(1.15)}
						title={t("放大", "Zoom in")}
						aria-label={t("放大", "Zoom in")}
					>
						+
					</button>
				</span>
				{/* 读数只留缩放比例，x/y 放 title：那一串太长，是折行的元凶 */}
				<span ref={readoutRef} className="canvas-readout" title={t("当前缩放", "Current zoom")} />
				<span className="canvas-count" title={t(`${nodes.length} 个节点`, `${nodes.length} steps`)}>
					{nodes.length}
				</span>
				{selected.length > 0 ? (
					<>
						<span className="canvas-bar-sel" title={t(`已选 ${selected.length} 个`, `${selected.length} selected`)}>
							{selected.length}
						</span>
						<button
							type="button"
							className="canvas-icon-btn"
							onClick={() => setSelected([])}
							title={t("取消选择", "Clear selection")}
							aria-label={t("取消选择", "Clear selection")}
						>
							<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
								<path
									d="M4 4l8 8M12 4l-8 8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					</>
				) : null}
			</div>
			{doc.goal ? <div className="canvas-goal">{doc.goal}</div> : null}
			<div className="canvas-hint">
				{t(
					"拖空白平移 · Shift+拖框选 · Z+拖框选放大 · +/- 缩放 · 双击节点开工",
					"Drag to pan · Shift+drag to box-select · Z+drag to zoom · +/- to zoom · double-click to start",
				)}
			</div>
		</div>
	);
}
