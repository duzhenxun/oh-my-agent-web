/**
 * 画布的落盘（一条会话一份 JSON）。
 *
 * 为什么不塞进 settings.json / 快照：画布是**工作产物**（可长到几十个节点），
 * 和"界面偏好"不是一个量级；也不该每帧跟着快照序列化一遍。
 * 放 `<dataDir>/canvas/<conversationId>.json`：好查、好备份、坏了只坏一份。
 *
 * 读取是**惰性 + 缓存**：`ensure()` 第一次读盘，之后走内存；
 * 写入时先写临时文件再 rename（半截 JSON 会让画布永远打不开）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasArtifact, CanvasDoc, CanvasEdge, CanvasNode, CanvasNodeKind, CanvasNodeStatus } from "../protocol.js";

const STATUSES: readonly CanvasNodeStatus[] = ["todo", "doing", "done", "blocked"];
const KINDS: readonly CanvasNodeKind[] = ["task", "milestone", "risk", "doc", "decision"];

export type CanvasStore = {
	/** 读一份（第一次会读盘）；没有就 null */
	ensure(conversationId: string | null): CanvasDoc | null;
	/** 写回一份（落盘 + 进缓存） */
	save(conversationId: string, doc: CanvasDoc): void;
	/** 会话被删时清掉 */
	forget(conversationId: string): void;
};

/** 会话 id 是 UUID 那类；只留安全字符，防止 `../` 这种把文件写到目录外 */
function fileNameOf(conversationId: string): string {
	return `${conversationId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

function isNode(value: unknown): value is CanvasNode {
	const node = value as CanvasNode | null;
	return (
		typeof node === "object" &&
		node !== null &&
		typeof node.id === "string" &&
		typeof node.title === "string" &&
		typeof node.x === "number" &&
		typeof node.y === "number" &&
		STATUSES.includes(node.status) &&
		(node.kind === undefined || KINDS.includes(node.kind))
	);
}

const ARTIFACT_KINDS: readonly CanvasArtifact["kind"][] = ["file", "command", "note"];

function isArtifact(value: unknown): value is CanvasArtifact {
	const artifact = value as CanvasArtifact | null;
	return (
		typeof artifact === "object" &&
		artifact !== null &&
		typeof artifact.label === "string" &&
		ARTIFACT_KINDS.includes(artifact.kind)
	);
}

function isEdge(value: unknown): value is CanvasEdge {
	const edge = value as CanvasEdge | null;
	return typeof edge === "object" && edge !== null && typeof edge.from === "string" && typeof edge.to === "string";
}

/** 从盘上读一份；结构对不上就当没有（不因为一份坏文件让整条会话打不开） */
function parseDoc(raw: string): CanvasDoc | null {
	try {
		const value = JSON.parse(raw) as Partial<CanvasDoc> | null;
		if (typeof value !== "object" || value === null) return null;
		if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
		const cleanNode = (node: CanvasNode, depth: number): CanvasNode => {
			// 坏掉的产出项直接丢掉，别让一份脏数据把整张画布打不开
			let next: CanvasNode = node;
			if (Array.isArray(node.artifacts)) {
				const artifacts = node.artifacts.filter(isArtifact);
				next = artifacts.length === 0 ? { ...next, artifacts: undefined } : { ...next, artifacts };
			}
			// 子计划：最多三层，坏掉的整层丢掉（不让一份脏数据把画布打不开）
			if (node.sub !== undefined && depth < 3) {
				const sub = node.sub as { nodes?: unknown; edges?: unknown } | null;
				if (typeof sub === "object" && sub !== null && Array.isArray(sub.nodes) && Array.isArray(sub.edges)) {
					const subNodes = sub.nodes.filter(isNode).map((each) => cleanNode(each, depth + 1));
					const subEdges = sub.edges.filter(isEdge);
					next =
						subNodes.length === 0
							? { ...next, sub: undefined }
							: { ...next, sub: { nodes: subNodes, edges: subEdges } };
				} else {
					next = { ...next, sub: undefined };
				}
			} else if (node.sub !== undefined) {
				next = { ...next, sub: undefined };
			}
			return next;
		};
		const nodes = value.nodes.filter(isNode).map((node) => cleanNode(node, 0));
		// 一条节点都没有 = 等于没有画布（界面显示空状态，而不是一个空壳抬头）
		if (nodes.length === 0) return null;
		return {
			goal: typeof value.goal === "string" ? value.goal : "",
			nodes,
			edges: value.edges.filter(isEdge),
			rev: typeof value.rev === "number" && Number.isFinite(value.rev) ? value.rev : 1,
			updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
		};
	} catch {
		return null;
	}
}

export function createCanvasStore(dataDir: string): CanvasStore {
	const dir = join(dataDir, "canvas");
	const cache = new Map<string, CanvasDoc | null>();

	return {
		ensure(conversationId) {
			if (conversationId === null) return null;
			if (cache.has(conversationId)) return cache.get(conversationId) ?? null;
			let doc: CanvasDoc | null = null;
			try {
				doc = parseDoc(readFileSync(join(dir, fileNameOf(conversationId)), "utf8"));
			} catch {
				// 没这个文件是最常见的情况（这条会话还没画过），不是错误
				doc = null;
			}
			cache.set(conversationId, doc);
			return doc;
		},

		save(conversationId, doc) {
			cache.set(conversationId, doc);
			try {
				mkdirSync(dir, { recursive: true });
				const target = join(dir, fileNameOf(conversationId));
				const temp = `${target}.tmp`;
				writeFileSync(temp, JSON.stringify(doc, null, "\t"), "utf8");
				// rename 是原子的：进程半路挂了也只会留下一个 .tmp，不会留下半截正文
				renameSync(temp, target);
			} catch {
				// 落盘失败不影响本次使用（内存里这份还是对的），下次读盘才会回到旧值
			}
		},

		forget(conversationId) {
			cache.delete(conversationId);
			try {
				rmSync(join(dir, fileNameOf(conversationId)), { force: true });
			} catch {
				// 删不掉就算了：只是一份没人会再读的文件
			}
		},
	};
}
