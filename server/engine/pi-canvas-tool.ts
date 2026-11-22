/**
 * 会话里的 `canvas` 工具：把「接下来要做什么」画到右侧的画布上。
 *
 * 用户的原话（2026-11-23）：「我说一句话之后就可以生成未来要做的事情，然后出来一个无限画布」——
 * 所以这个工具的定位不是"记笔记"，是**把一句话拆成一张能照着干的图**：
 * 节点 = 一次能做完的具体动作，连线 = 谁必须先完成。
 *
 * 坐标由宿主算（`session/canvas.ts` 的 `layout`）：模型只给标题和依赖。
 * 让它自己给 x/y 的话，十个节点能摆成一片谁都看不懂的散点。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	CANVAS_MAX_NODES,
	describe,
	isEmptyDoc,
	planDoc,
	planSub,
	addNodes,
	removeNodes,
	setStatus,
	updateNode,
	type CanvasPort,
} from "../session/canvas.js";

type CanvasToolOptions = {
	/** 惰性取端口：宿主先建运行时、后挂画布存储 */
	port: () => CanvasPort | null;
	/** 这条会话的 id：画布是按会话存的 */
	conversationId: string;
};

type Failure = { content: Array<{ type: "text"; text: string }>; details: undefined; isError: true };
type Success = { content: Array<{ type: "text"; text: string }>; details: undefined };

function ok(text: string): Success {
	return { content: [{ type: "text", text }], details: undefined };
}

function failure(error: unknown): Failure {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: undefined,
		isError: true,
	};
}

export function makeCanvasToolExtension(options: CanvasToolOptions): InlineExtension {
	return {
		name: "agent-web-canvas",
		hidden: true,
		factory: (pi) => {
			pi.registerTool(
				defineTool({
					name: "canvas",
					label: "canvas",
					description: [
						"把「接下来要做什么」画到用户右侧的无限画布上（一条会话一份，用户能直接看见）。",
						"节点 = 一次能做完的具体动作；edges 连出先后顺序（from 先于 to）。坐标由宿主自动排，**不要传 x/y**。",
						"Actions:",
						"- `read`：读当前画布（改之前先读）。",
						"- `plan`：**整体画一张新图**（替换旧的）。给 `goal`（用户那句话的浓缩）+ `nodes` + `edges`。用户说「我要做一个 X / 帮我拆一下 / 规划一下」时用这个。",
						"- `sub_plan`：给 `id` 指定的那一步挂一层**子计划**（`nodes` + `edges`）。主图只留这一步的汇总，用户双击节点钻进去看细节。一步的活超过 3 条子动作时用它。",
						"- `add`：往现有图上追加节点 / 连线。",
						"- `update`：改某个节点的标题或说明。",
						"- `status`：把某个节点标成 doing / done / blocked / todo（干完一步就标一下）。",
						"- `remove`：删节点（连带删掉挂在它上面的线）。",
						"- `clear`：清空整张画布。",
					].join("\n"),
					promptSnippet: "把接下来要做的事画成一张图（无限画布）",
					promptGuidelines: [
						"用户描述一件要做的、需要多步才能完成的事（「我要做一个签到活动」「把这个需求拆一下」）时，用 `canvas` 的 `plan` 把它画成图——这是这个工作台展示计划的主要方式，比在正文里列 1.2.3 更好用。",
						"节点粒度是**一次能做完的具体动作**（「在活动后台建档期配置」），不是空泛阶段（「开发」）。一张图 5–10 个节点最好，最多 40 个。",
						"节点类型别全用默认的 task：交付点用 milestone（「上线」「灰度完成」）、容易翻车的点用 risk（「连签跨零点」「时区切天」）、要人拍板的用 decision、参考资料用 doc。图上会按类型显示不同图标和颜色，全是 task 会很难读。",
						"只在真有先后依赖时才连 edges；能并行的不要硬连成一条线。",
						"不要传坐标：x/y 由宿主按依赖分层算好。",
						"改图之前先 `read`；改完用一句话报「画了 N 个节点、几条依赖」，不要把整张图在正文里再念一遍。",
						"开始干某一步时用 `status` 把它标成 doing，干完标 done —— 用户在画布上看得到进度。",
						"一步的活儿要是自己也得好几步（「上线」里面还有 CR / 灰度 / 全量），用 `sub_plan` 把它拆到子计划里，别主图越铺越长。",
						"改子计划里的节点时给 `parent`（= 那一步的 id）；不传就是主图。",
						"如果用户没有要求画图、只是在问问题，就不要调用这个工具。",
					],
					parameters: Type.Object({
						action: Type.Union([
							Type.Literal("read"),
							Type.Literal("plan"),
							Type.Literal("add"),
							Type.Literal("update"),
							Type.Literal("status"),
							Type.Literal("remove"),
							Type.Literal("clear"),
							Type.Literal("sub_plan"),
						]),
						goal: Type.Optional(Type.String({ description: "这张图要达成什么（用户那句话的浓缩）" })),
						nodes: Type.Optional(
							Type.Array(
								Type.Object({
									id: Type.Optional(Type.String({ description: "短 id（仅字母数字-_），不传自动编号；后续改它要用这个" })),
									title: Type.String({ description: "一句话说清这一步做什么" }),
									detail: Type.Optional(Type.String({ description: "怎么做 / 验收标准，一两句" })),
									kind: Type.Optional(
										Type.Union([
											Type.Literal("task"),
											Type.Literal("milestone"),
											Type.Literal("risk"),
											Type.Literal("doc"),
											Type.Literal("decision"),
										]),
									),
									status: Type.Optional(
										Type.Union([
											Type.Literal("todo"),
											Type.Literal("doing"),
											Type.Literal("done"),
											Type.Literal("blocked"),
										]),
									),
								}),
							),
						),
						edges: Type.Optional(
							Type.Array(
								Type.Object({
									from: Type.String(),
									to: Type.String(),
									label: Type.Optional(Type.String()),
								}),
							),
						),
						id: Type.Optional(Type.String({ description: "update / status / sub_plan 要改哪个节点" })),
						parent: Type.Optional(
							Type.String({ description: "改子计划里的节点时传：那一步的 id。不传 = 主图" }),
						),
						status: Type.Optional(
							Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done"), Type.Literal("blocked")]),
						),
						title: Type.Optional(Type.String()),
						detail: Type.Optional(Type.String()),
						ids: Type.Optional(Type.Array(Type.String(), { description: "remove：要删的节点 id" })),
					}),
					async execute(_id, params) {
						const port = options.port();
						if (!port) return failure("画布还没准备好（宿主没接上画布存储）");
						try {
							const current = port.read(options.conversationId);

							const parent = typeof params.parent === "string" && params.parent !== "" ? params.parent : null;

							if (params.action === "read") return ok(describe(current));

							if (params.action === "sub_plan") {
								if (current === null) return failure("这条会话还没有画布，先用 action=plan 画一张");
								if (!params.id) return failure("sub_plan 需要 id（挂到哪一步下面）");
								if (!params.nodes || params.nodes.length === 0) return failure("sub_plan 至少要给一个 nodes");
								const doc = planSub(current, params.id, params.nodes, params.edges ?? []);
								if (doc === null) return failure(`没有这个节点：${params.id}`);
								await port.write(options.conversationId, doc);
								const host = doc.nodes.find((node) => node.id === params.id);
								return ok(
									`已给 ${params.id} 挂上子计划：${host?.sub?.nodes.length ?? 0} 个子步骤、${host?.sub?.edges.length ?? 0} 条依赖。用户双击那一步就能钻进去看。`,
								);
							}

							if (params.action === "clear") {
								// 清空 = 写一份空文档，但"空文档"在快照里等于没有画布
								const empty = planDoc(current, "", [], []);
								await port.write(options.conversationId, empty);
								return ok("画布已清空。");
							}

							if (params.action === "plan") {
								if (!params.nodes || params.nodes.length === 0) return failure("plan 至少要给一个 nodes");
								const doc = planDoc(current, params.goal ?? "", params.nodes, params.edges ?? []);
								await port.write(options.conversationId, doc);
								return ok(
									`画布已重画：${doc.nodes.length} 个节点、${doc.edges.length} 条依赖。用户右侧的画布标签已经更新。`,
								);
							}

							if (!current || isEmptyDoc(current)) return failure("这条会话还没有画布，先用 action=plan 画一张");
							const levelNodes = parent === null
								? current.nodes
								: (current.nodes.find((node) => node.id === parent)?.sub?.nodes ?? []);

							if (params.action === "add") {
								if (!params.nodes || params.nodes.length === 0) return failure("add 至少要给一个 nodes");
								const doc = addNodes(current, params.nodes, params.edges ?? [], parent);
								await port.write(options.conversationId, doc);
								return ok(`已追加：现在共 ${doc.nodes.length} 个节点、${doc.edges.length} 条依赖。`);
							}

							if (params.action === "update") {
								if (!params.id) return failure("update 需要 id");
								if (!levelNodes.some((node) => node.id === params.id)) return failure(`没有这个节点：${params.id}`);
								const doc = updateNode(current, params.id, { title: params.title, detail: params.detail }, parent);
								await port.write(options.conversationId, doc);
								return ok(`已更新节点 ${params.id}。`);
							}

							if (params.action === "status") {
								if (!params.id) return failure("status 需要 id");
								if (!levelNodes.some((node) => node.id === params.id)) return failure(`没有这个节点：${params.id}`);
								const doc = setStatus(current, params.id, params.status ?? "done", parent);
								await port.write(options.conversationId, doc);
								return ok(`节点 ${params.id} 现在状态是 ${params.status ?? "done"}。`);
							}

							// remove
							if (!params.ids || params.ids.length === 0) return failure("remove 需要 ids");
							const doc = removeNodes(current, params.ids, parent);
							await port.write(options.conversationId, doc);
							const gone = current.nodes.length - doc.nodes.length;
							return ok(`删掉 ${gone} 个节点，还剩 ${doc.nodes.length} 个。上限 ${CANVAS_MAX_NODES}。`);
						} catch (error) {
							return failure(error);
						}
					},
				}),
			);
		},
	};
}
