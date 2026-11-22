/**
 * 画布：agent 把「接下来要做什么」画成一张图（纯函数 + 窄端口）。
 *
 * 分层和 `session/appearance.ts`、`cron/tool.ts` 一样：**排布、校验、文档操作都留在宿主**，
 * 引擎层只负责把模型的参数递进来（见 `engine/pi-canvas-tool.ts`）。
 * 这样"节点怎么排、什么算合法"能单测，也不让引擎认识快照和文件。
 *
 * 三条硬规则（都是为了让图"能用"而不是"能看"）：
 *   1. **坐标是服务端算的**：模型只给 title / 依赖，不给 x/y —— 让它摆位置必然摆成一片乱码；
 *   2. **按依赖分层**：没有前置的排最左，每条依赖往右推一层（最长路径），同层竖着排；
 *   3. **有上限**：40 个节点 / 80 条边。超出就截断并如实告诉模型，而不是画一张看不清的图。
 */
import type { CanvasDoc, CanvasEdge, CanvasNode, CanvasNodeStatus } from "../protocol.js";

/** 图上最多这么多节点（再多就不是"一眼看全"，而是又一棵树） */
export const CANVAS_MAX_NODES = 40;
/** 最多这么多条依赖线 */
export const CANVAS_MAX_EDGES = 80;
const TITLE_MAX = 80;
const DETAIL_MAX = 200;
const GOAL_MAX = 120;
/** 节点在世界坐标里的排布间距 */
const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 132;
const ORIGIN_X = 40;
const ORIGIN_Y = 64;

const STATUSES: readonly CanvasNodeStatus[] = ["todo", "doing", "done", "blocked"];

/** 宿主端口：读某条会话的画布 / 写回一份（写的人负责落盘 + 推快照） */
export type CanvasPort = {
	read(conversationId: string): CanvasDoc | null;
	write(conversationId: string, doc: CanvasDoc): Promise<CanvasDoc>;
};

function text(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, max);
}

function statusOf(value: unknown): CanvasNodeStatus {
	return STATUSES.includes(value as CanvasNodeStatus) ? (value as CanvasNodeStatus) : "todo";
}

/** 模型给的 id 只接受安全字符；不合法的丢掉（后面按顺序补 n1/n2…） */
function idOf(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return /^[A-Za-z0-9_-]{1,32}$/.test(trimmed) ? trimmed : null;
}

/** 去重用的 id 表：已经占用的就往后顺延，避免模型两次都给 `n1` 撞在一起 */
function uniqueId(used: Set<string>, base: string): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let index = 2;
	while (used.has(`${base}-${index}`)) index += 1;
	const next = `${base}-${index}`;
	used.add(next);
	return next;
}

export type NodeInput = { id?: unknown; title?: unknown; detail?: unknown; status?: unknown; order?: unknown };
export type EdgeInput = { from?: unknown; to?: unknown; label?: unknown };

/**
 * 模型给的节点清单 → 合法节点（先不排坐标）。
 * 没标题的节点直接丢：一个只有 id 的空框在图上没有任何用处。
 */
export function normalizeNodes(input: readonly NodeInput[]): CanvasNode[] {
	const used = new Set<string>();
	const nodes: CanvasNode[] = [];
	for (const [index, raw] of input.entries()) {
		const title = text(raw.title, TITLE_MAX);
		if (title === "") continue;
		const id = uniqueId(used, idOf(raw.id) ?? `n${index + 1}`);
		const detail = text(raw.detail, DETAIL_MAX);
		const orderRaw = typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : index;
		nodes.push({
			id,
			title,
			...(detail === "" ? {} : { detail }),
			status: statusOf(raw.status),
			x: 0,
			y: 0,
			order: orderRaw,
		});
		if (nodes.length >= CANVAS_MAX_NODES) break;
	}
	return nodes;
}

/** 连线只保留两端都存在的（指向不存在的节点 = 图上一个悬空箭头，不能留） */
export function normalizeEdges(input: readonly EdgeInput[], nodes: readonly CanvasNode[]): CanvasEdge[] {
	const known = new Set(nodes.map((node) => node.id));
	const edges: CanvasEdge[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		const from = idOf(raw.from);
		const to = idOf(raw.to);
		if (from === null || to === null || from === to) continue;
		if (!known.has(from) || !known.has(to)) continue;
		const key = `${from}->${to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const label = text(raw.label, 24);
		edges.push({ from, to, ...(label === "" ? {} : { label }) });
		if (edges.length >= CANVAS_MAX_EDGES) break;
	}
	return edges;
}

/**
 * 按依赖分层排坐标。
 *
 * depth = 到它的**最长**前置链（不是最短）：一个节点要等两个前置都完事，
 * 它就该排在更靠右那一列，否则线会往回绕。
 * 有环时用访问中标记兜住（宁可排在同一列，也不能无限递归）。
 */
export function layout(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): CanvasNode[] {
	const incoming = new Map<string, string[]>();
	for (const node of nodes) incoming.set(node.id, []);
	for (const edge of edges) incoming.get(edge.to)?.push(edge.from);

	const depthCache = new Map<string, number>();
	const visiting = new Set<string>();
	const depthOf = (id: string): number => {
		const cached = depthCache.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const parents = incoming.get(id) ?? [];
		let depth = 0;
		for (const parent of parents) depth = Math.max(depth, depthOf(parent) + 1);
		visiting.delete(id);
		const capped = Math.min(depth, CANVAS_MAX_NODES);
		depthCache.set(id, capped);
		return capped;
	};

	// 同层里按 order（没给 order 就按原顺序）排，保证同一个输入每次排出来一样
	const ordered = nodes
		.map((node, index) => ({ node, index }))
		.sort((a, b) => (a.node.order ?? a.index) - (b.node.order ?? b.index));

	const rows = new Map<number, number>();
	return ordered.map(({ node }) => {
		const depth = depthOf(node.id);
		const row = rows.get(depth) ?? 0;
		rows.set(depth, row + 1);
		return { ...node, x: ORIGIN_X + depth * COLUMN_WIDTH, y: ORIGIN_Y + row * ROW_HEIGHT };
	});
}

function nextRev(previous: CanvasDoc | null): number {
	return (previous?.rev ?? 0) + 1;
}

/** 一份新画布（整体替换）：给目标 + 节点 + 连线，坐标由 `layout` 算 */
export function planDoc(previous: CanvasDoc | null, goal: unknown, nodes: readonly NodeInput[], edges: readonly EdgeInput[]): CanvasDoc {
	const normalized = normalizeNodes(nodes);
	const normalizedEdges = normalizeEdges(edges, normalized);
	return {
		goal: text(goal, GOAL_MAX),
		nodes: layout(normalized, normalizedEdges),
		edges: normalizedEdges,
		rev: nextRev(previous),
		updatedAt: Date.now(),
	};
}

/** 空画布：没有任何节点时返回 null（快照里就是"还没有画布"） */
export function isEmptyDoc(doc: CanvasDoc | null): boolean {
	return doc === null || doc.nodes.length === 0;
}

/** 改一个节点的状态 */
export function setStatus(doc: CanvasDoc, id: string, status: unknown): CanvasDoc {
	return {
		...doc,
		nodes: doc.nodes.map((node) => (node.id === id ? { ...node, status: statusOf(status) } : node)),
		rev: doc.rev + 1,
		updatedAt: Date.now(),
	};
}

/** 改标题 / 说明 */
export function updateNode(doc: CanvasDoc, id: string, patch: { title?: unknown; detail?: unknown }): CanvasDoc {
	const title = patch.title === undefined ? null : text(patch.title, TITLE_MAX);
	const detail = patch.detail === undefined ? null : text(patch.detail, DETAIL_MAX);
	return {
		...doc,
		nodes: doc.nodes.map((node) => {
			if (node.id !== id) return node;
			const next: CanvasNode = { ...node };
			if (title !== null && title !== "") next.title = title;
			if (detail !== null) {
				if (detail === "") delete next.detail;
				else next.detail = detail;
			}
			return next;
		}),
		rev: doc.rev + 1,
		updatedAt: Date.now(),
	};
}

/** 追加若干节点（坐标接着最后一行往下排；有依赖的会被 `layout` 重新归位） */
export function addNodes(doc: CanvasDoc, nodes: readonly NodeInput[], edges: readonly EdgeInput[]): CanvasDoc {
	const used = new Set(doc.nodes.map((node) => node.id));
	const fresh = normalizeNodes(nodes).map((node) => ({ ...node, id: uniqueId(used, node.id) }));
	if (fresh.length === 0) return doc;
	const mergedEdges = normalizeEdges([...doc.edges, ...edges], [...doc.nodes, ...fresh]);
	return {
		...doc,
		nodes: layout([...doc.nodes, ...fresh], mergedEdges),
		edges: mergedEdges,
		rev: doc.rev + 1,
		updatedAt: Date.now(),
	};
}

/** 删节点（连带删掉挂在它上面的线） */
export function removeNodes(doc: CanvasDoc, ids: readonly string[]): CanvasDoc {
	const kill = new Set(ids);
	const nodes = doc.nodes.filter((node) => !kill.has(node.id));
	return {
		...doc,
		nodes,
		edges: doc.edges.filter((edge) => !kill.has(edge.from) && !kill.has(edge.to)),
		rev: doc.rev + 1,
		updatedAt: Date.now(),
	};
}

/** 用户在画布上拖动后回写坐标（只动位置，不改内容） */
export function moveNodes(doc: CanvasDoc, moves: readonly { id: string; x: number; y: number }[]): CanvasDoc {
	const byId = new Map(moves.map((move) => [move.id, move]));
	return {
		...doc,
		nodes: doc.nodes.map((node) => {
			const move = byId.get(node.id);
			if (!move) return node;
			return { ...node, x: Number.isFinite(move.x) ? move.x : node.x, y: Number.isFinite(move.y) ? move.y : node.y };
		}),
		rev: doc.rev + 1,
		updatedAt: Date.now(),
	};
}

/**
 * 给模型看的紧凑描述：它下一轮要改图时先读这个。
 * 故意不带坐标 —— 坐标是宿主算的，模型知道顺序就够了。
 */
export function describe(doc: CanvasDoc | null): string {
	if (isEmptyDoc(doc)) return "画布是空的（还没有任何节点）。用户还没让你画，或者你还没画。";
	const canvas = doc as CanvasDoc;
	const lines = [`画布目标：${canvas.goal || "（没写）"}`, `节点 ${canvas.nodes.length} 个，依赖 ${canvas.edges.length} 条：`];
	for (const node of canvas.nodes) {
		const detail = node.detail ? ` —— ${node.detail}` : "";
		lines.push(`- [${node.status}] ${node.id}: ${node.title}${detail}`);
	}
	if (canvas.edges.length > 0) {
		lines.push("依赖：");
		for (const edge of canvas.edges) {
			lines.push(`- ${edge.from} → ${edge.to}${edge.label ? `（${edge.label}）` : ""}`);
		}
	}
	return lines.join("\n");
}
