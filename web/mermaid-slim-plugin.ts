/**
 * ADR-0040：mermaid 图型裁剪（构建期）——把 npm 包从 7.3MB 压到 4.4MB 的唯一一处大动刀。
 *
 * 为什么做：`mermaid` 一个依赖就占了构建产物的 5MB（web/dist 6.4MB 里的 78%），但它自己
 * 是**按图型懒加载**的：`mermaid.core` 里每个图型都是一条 `{ detector, loader }` 注册项，
 * loader 才 `import()` 真正的图型 chunk。也就是说 —— 一个只画 flowchart / sequence 的工作台，
 * 却把 elkjs(1.4MB)、cytoscape(425KB)、katex(253KB)、usecase(184KB)、architecture(145KB)
 * 一起发给了用户。这些文件永远不会被请求，但会一直躺在 npm tarball、磁盘和 docker 镜像里。
 *
 * 裁剪方式：**在解析阶段把模块换成空壳**，而不是构建完再删文件。区别很重要：
 *   - 删文件 → `mermaid.core` 里的 `__vite__mapDeps` 数组还指着它们，preload 会 404，
 *     且一旦某个**保留下来的** chunk 静态 import 了被删文件，整条链路在加载期就炸了（难排查）；
 *   - 换空壳 → 依赖图始终完整，被裁图型的 `loader()` 拿到一个「一碰就报错并说明原因」的对象，
 *     错误沿 mermaid 的 reject 上抛，落到 `MermaidDiagram` 已有的失败回落（ADR-0029）里显示源码 +
 *     一行错误。用户看到的是「这个图型被裁了」，不是白屏，也不是 404 噪音。
 *
 * 裁掉的东西（默认值）：
 *   | 图型 id | 为什么裁 |
 *   |---|---|
 *   | architecture / usecase / swimlane / agentflow / treeView      | 编码工作台里几乎不出现的图型 |
 *   | eventmodeling / ishikawa / venn / treemap / wardley / cynefin | 实验性/小众图型 |
 *   | railroad / railroadEbnf / railroadAbnf / railroadPeg          | 语法图，只有写编译器的人用 |
 *   | mindmap                                                       | 连带 cytoscape 系（-504KB），见下 |
 *   | （裸包）katex   | 只服务于**图节点标签里的 `$公式$`**；正文里的公式不经过 mermaid（-253KB）|
 *   | （裸包）cytoscape / cytoscape-cose-bilkent / cytoscape-fcose | 只有 mindmap 用（-504KB）|
 *
 * 保留：flowchart / sequence / class / state / er / gantt / pie / journey / gitGraph /
 *       timeline / quadrantChart / xychart / sankey / block / packet / radar / kanban / requirement / info。
 *
 * 想换回完整版（或只想保留 mindmap、公式标签）——不用改代码，两个环境变量：
 *   OH_MY_AGENT_WEB_MERMAID_FULL=1            # 完全不裁，回到 7.3MB
 *   OH_MY_AGENT_WEB_MERMAID_KEEP=mindmap,katex # 从默认裁剪表里豁免指定项（id 或裸包名）
 *
 * 版本漂移怎么办：图型 id → chunk 文件的映射是**构建时从 mermaid 自己的 dist 源码里解析**的
 * （`var idNN = "<id>"; … await import("./chunks/mermaid.core/<file>")`），不写死带 hash 的文件名，
 * 所以 `npm update mermaid` 之后不需要改这里。真正会漂移的只有「图型 id 改名/删除」：那种情况下
 * 构建日志会打一条 `未找到图型` 的提示，不会静默失效。
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Plugin } from "vite";

/** 虚拟模块前缀（`\0` 开头 = 约定上「不落地到磁盘」的模块） */
const STUB_PREFIX = "\0oh-my-agent-web-mermaid-pruned:";

/** 给用户看的错误文案：会出现在 MermaidDiagram 的失败回落里 */
const REASON = "该 mermaid 图型已在构建期裁剪（见 web/mermaid-slim-plugin.ts / ADR-0040）";

/** 默认裁掉的图型 id（mermaid 的 diagram id，不是文件名） */
const PRUNED_DIAGRAMS = [
	"architecture",
	"c4",
	"usecase",
	"swimlane",
	"agentflow",
	"treeView",
	"eventmodeling",
	"ishikawa",
	"venn",
	"treemap",
	"wardley",
	"cynefin",
	"railroad",
	"railroadEbnf",
	"railroadAbnf",
	"railroadPeg",
	"mindmap",
];

/**
 * 额外裁掉的 chunk 文件名**前缀**。
 *
 * 为什么需要它：有些代码挂在 mermaid 的「布局注册表」上而不是图型注册表上，
 * 被藏在共享 chunk 里懒加载 —— `chunk-EJLWFMJV`（flowchart/class/state 共用的核心）里就有
 * `loader: async () => await import("./swimlanes-B3ENRKFQ.mjs")`。按图型 id 完全看不到它，
 * 但裁掉 `swimlane` 之后这 100KB 就是纯死重量。文件名尾部的 hash 跨版本会变，所以按前缀匹配。
 */
const PRUNED_CHUNK_PREFIXES = ["swimlanes-"];

/** 默认裁掉的重依赖（裸包名）→ 裁掉后哪些图型失效 */
const PRUNED_DEPS: Record<string, string> = {
	// elkjs 不在这里 —— 踩过的坑：mermaid 12 把 **ELK 做成了 flowchart/class/state/er 的默认布局**
	// （`getConfig().layout` 默认 "elk"），裁掉之后这几个最常用的图型会在 render 时直接报错。
	// 想剔它的话，得先在 MermaidDiagram 里把 layout 显式换成 "dagre"，那是改渲染效果的决策，不在构建期默默做。
	katex: "图节点标签里的公式",
	cytoscape: "mindmap",
	"cytoscape-cose-bilkent": "mindmap 布局",
	"cytoscape-fcose": "mindmap 布局",
};

/** 一次构建里算出来的「要裁什么」 */
type Plan = {
	/** 图型 chunk 的文件名（不含 .mjs），例如 `architectureDiagram-ZHVYKT53` */
	chunks: Set<string>;
	/** 裸包名，例如 `katex` */
	deps: Set<string>;
	/** 构建日志用 */
	notes: string[];
};

type Registry = {
	/** mermaid dist 目录，用来判断 importer 是不是 mermaid 自己 */
	distDir: string;
	/** diagram id → chunk 文件名（不含 .mjs） */
	byId: Map<string, string>;
	/** mermaid 自带的所有 chunk 文件名（不含 .mjs），给前缀匹配用 */
	chunkNames: string[];
};

/** Windows 的路径是反斜杠，而 Vite 的 module id 一律正斜杠：比较前先统一 */
function toPosix(p: string): string {
	return p.split("\\").join("/");
}

/**
 * 从 mermaid 的 dist 源码里解析「图型 id → chunk 文件」的映射。
 *
 * 源码形态很规整（dist 未压缩）：
 *   var id26 = "architecture";
 *   var loader26 = __name(async () => {
 *     const { diagram: diagram2 } = await import("./chunks/mermaid.core/architectureDiagram-ZHVYKT53.mjs");
 *     return { id: id26, diagram: diagram2 };
 *   }, "loader");
 *
 * 只要这条 `import(...)` 后面紧跟 `return { id: idNN, … }`，就能把 chunk 和 id 对上。
 * 写死的只有这个语法形状；文件名/编号/normalize 无关。
 */
function readRegistry(): Registry {
	const require = createRequire(import.meta.url);
	// mermaid 的 exports["."] → dist/mermaid.core.mjs（就是注册表所在文件）
	// 注意：Windows 上 resolve() 返回 `C:\...\dist\mermaid.core.mjs`，用 "/" 切会得到空串，
	// 所以先转 posix 再算目录（否则裁草在 Windows 上要么直接报错、要么静默不生效）。
	const entry = require.resolve("mermaid");
	const distDir = toPosix(dirname(entry));
	if (!distDir.endsWith("/dist")) throw new Error(`[oh-my-agent-web] mermaid 入口不在 dist 下：${entry}`);

	const source = readFileSync(entry, "utf8");
	const ids = new Map<string, string>();
	for (const m of source.matchAll(/var id(\d*) = "([^"]+)";/g)) ids.set(m[1], m[2]);

	const byId = new Map<string, string>();
	// 两种写法都要认：`return { id: id26, diagram }` 与简写 `return { id, diagram }`（c4 就是后者）
	const chunkRe =
		/await import\("\.\/chunks\/mermaid\.core\/([^"]+)"\);\s*return \{ id(?:: id(\d*))?, diagram: [A-Za-z0-9_$]+ \};/g;
	for (const m of source.matchAll(chunkRe)) {
		const id = ids.get(m[2] ?? "");
		if (!id) continue;
		byId.set(id, m[1].replace(/\.mjs$/, ""));
	}
	return { distDir, byId, chunkNames: chunkNamesOf(distDir) };
}

/** 磁盘上的 chunk 清单（含没挂进图型注册表的，如布局注册表里的 swimlanes-*） */
function chunkNamesOf(distDir: string): string[] {
	return readdirSync(`${distDir}/chunks/mermaid.core`)
		.filter((f) => f.endsWith(".mjs"))
		.map((f) => f.replace(/\.mjs$/, ""));
}

/** 读环境变量里的豁免项（`OH_MY_AGENT_WEB_MERMAID_KEEP=mindmap,katex`） */
function readKeep(): Set<string> {
	const raw = process.env.OH_MY_AGENT_WEB_MERMAID_KEEP ?? "";
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

function makePlan(): Plan {
	const notes: string[] = [];
	const chunks = new Set<string>();
	const deps = new Set<string>();

	if (process.env.OH_MY_AGENT_WEB_MERMAID_FULL === "1") {
		notes.push("OH_MY_AGENT_WEB_MERMAID_FULL=1：跳过裁剪（完整 mermaid）");
		return { chunks, deps, notes };
	}

	const keep = readKeep();
	const registry = readRegistry();

	for (const id of PRUNED_DIAGRAMS) {
		if (keep.has(id)) continue;
		const chunk = registry.byId.get(id);
		if (!chunk) {
			notes.push(`未找到图型 "${id}"（mermaid 改过 id？），已跳过`);
			continue;
		}
		chunks.add(chunk);
	}

	// 挂在布局注册表上的懒加载实现（例如 swimlane / elk 布局）：图型裁了它们就是死重量
	if (!keep.has("swimlane")) {
		for (const base of registry.chunkNames) {
			if (PRUNED_CHUNK_PREFIXES.some((prefix) => base.startsWith(prefix))) chunks.add(base);
		}
	}

	for (const dep of Object.keys(PRUNED_DEPS)) {
		if (keep.has(dep)) continue;
		deps.add(dep);
	}

	// 裁 cytoscape 却留着 mindmap 的话，mindmap 只会在运行时抛一个 cytoscape 缺失的怪错误：
	// 直接把 mindmap 一起裁掉，用户看到的是「图型已裁剪」这句能读懂的话。
	if (deps.has("cytoscape") && !keep.has("mindmap")) {
		const chunk = registry.byId.get("mindmap");
		if (chunk) chunks.add(chunk);
	}

	return { chunks, deps, notes };
}

/** 空壳模块的代码。导出形状对齐 mermaid 真正期待的成员，让失败发生在 render 而不是 import。 */
function stubCode(kind: string, name: string): string {
	const head = `const REASON = ${JSON.stringify(REASON)};\nconst fail = () => {\n\tthrow new Error(\`\${REASON}：${name}\`);\n};\n`;

	switch (kind) {
		case "chunk":
			// 图型 chunk 与布局实现（如 swimlanes-*）共用一个空壳：mermaid 从图型 chunk 里取 `diagram`，
			// 从布局 chunk 里取 `layout` 一类的函数。导出形状按「真被调用时才报错」对齐，
			// 所以失败发生在 render 阶段（MermaidDiagram 的失败回落），而不是 import 阶段（白屏）。
			return `${head}export const diagram = {\n\tid: "oh-my-agent-web-pruned",\n\tdb: { clear: fail, getDiagramTitle: fail },\n\tparser: { parse: fail, yy: {} },\n\trenderer: { draw: fail },\n\tstyles: []\n};\nexport const layout = fail;\nexport const render = fail;\nexport const styles = [];\nexport default { diagram };\n`;
		case "katex":
			return `${head}export default { renderToString: fail };\n`;
		case "cytoscape":
			return `${head}export default function prunedCytoscape() {\n\tfail();\n};\n`;
		case "elkjs":
			return `${head}export default class PrunedELK {\n\tconstructor() {\n\t\tfail();\n\t}\n};\n`;
		default:
			return `${head}export default fail;\n`;
	}
}

/**
 * 构建期 mermaid 裁剪插件（只在 `vite build` 生效：开发期裁了会让人在本地踩到线上不存在的坑）。
 */
export function mermaidSlim(): Plugin {
	let plan: Plan = { chunks: new Set(), deps: new Set(), notes: [] };
	let distDir = "";

	return {
		name: "oh-my-agent-web:mermaid-slim",
		enforce: "pre",
		apply: "build",

		buildStart() {
			plan = makePlan();
			distDir = plan.chunks.size > 0 || plan.deps.size > 0 ? readRegistry().distDir : "";
		},

		resolveId(source, importer) {
			// 只拦 mermaid 自己发起的导入：别处的 `katex` / `cytoscape` 照旧（将来自己用得上）
			if (!importer || !distDir || !toPosix(importer).startsWith(distDir)) return null;

			// mermaid 自己的 chunk 有两种引用形式，都得认：
			//   core 里：`./chunks/mermaid.core/architectureDiagram-XXXX.mjs`
			//   chunk 之间（同目录）：`./swimlanes-XXXX.mjs`
			if (source.startsWith("./") && source.endsWith(".mjs")) {
				const base = source.slice(source.lastIndexOf("/") + 1).replace(/\.mjs$/, "");
				if (plan.chunks.has(base)) return `${STUB_PREFIX}chunk:${base}`;
				return null;
			}
			const dep = source.split("/")[0] ?? "";
			if (plan.deps.has(dep)) {
				if (dep === "katex") return `${STUB_PREFIX}katex:katex`;
				if (dep === "elkjs") return `${STUB_PREFIX}elkjs:elkjs`;
				if (dep.startsWith("cytoscape")) return `${STUB_PREFIX}cytoscape:${dep}`;
			}
			return null;
		},

		load(id) {
			if (!id.startsWith(STUB_PREFIX)) return null;
			const rest = id.slice(STUB_PREFIX.length);
			const at = rest.indexOf(":");
			return stubCode(rest.slice(0, at), rest.slice(at + 1));
		},

		closeBundle() {
			const count = plan.chunks.size + plan.deps.size;
			if (count === 0) {
				for (const note of plan.notes) console.log(`[oh-my-agent-web] ${note}`);
				return;
			}
			console.log(
				`[oh-my-agent-web] mermaid 已裁剪 ${plan.chunks.size} 个图型 chunk + ${plan.deps.size} 个重依赖` +
					`（保留完整版：OH_MY_AGENT_WEB_MERMAID_FULL=1；单独保留某项：OH_MY_AGENT_WEB_MERMAID_KEEP=mindmap,katex）`,
			);
			for (const note of plan.notes) console.log(`[oh-my-agent-web]   ${note}`);
		},
	};
}
