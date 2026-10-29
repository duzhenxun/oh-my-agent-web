/**
 * 「这一轮改了哪些文件」——从对话里的工具调用**推**出来，不额外记状态。
 *
 * 为什么推而不是让引擎报：pi 的会话记录里就是工具调用本身（`write { path }` /
 * `edit { path, edits }`），再存一份「改过的文件清单」等于给同一件事留两份真相，
 * 一旦某次工具失败或用户回滚就对称不起来。所以这里只认工具块，坏处也明确：
 * **只能看见工具改的**，`bash` 里 `mv` / `> file` 这种改法看不出来（界面上也不假装看得见）。
 *
 * 判定与提取三条纪律：
 *   - 只认「写文件」类的工具名（write / edit / apply_patch / write_file …，含 MCP 的
 *     `mcp__xxx__write_file` 这种），读文件、跑命令一律不算；
 *   - 只认**跑成功**的调用（`failed` / 还在 `running` 的都不能算改过）；同一条消息只留一个，
 *     顺序按第一次出现的顺序（人读起来跟做事顺序一致）；
 *   - 路径统一折成**相对工作区**：右侧预览面板的读取接口只吃相对路径（服务端还要挡越界），
 *     绝对路径在工作区之外的，标成 `outside` —— 界面上照样列出来，但点不开（不假装能预览）。
 */
import type { ToolBlock, UiMessage } from "./types.ts";

/**
 * 写文件类的工具名：pi 自带的是 `write` / `edit`，其余是别的引擎与 MCP 服务器的常见叫法
 * （`mcp__filesystem__write_file`、`str_replace_editor`、`apply_patch` …）。
 * 宁可少认几个也不敢放宽成 /write/ —— `read_write_config` 这种工具会把清单污染成噪声。
 */
const EDIT_TOOL =
	/(^|__)(write|edit|multiedit|multi_edit|apply_patch|patch|create_file|write_file|edit_file|update_file|modify_file|str_replace\w*)$/i;

/** 参数里常见的路径字段（pi 用 `path`；别家还有 `file_path` / `filePath`） */
const PATH_KEYS = ["path", "file_path", "filePath"];
/** 摘要被截断时（JSON 解析不了）从原文里抠路径：**只取第一个**，所以不带 g */
const PATH_IN_TEXT = /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)+)"/;

export type ChangedFile = {
	/** 相对工作区的路径（喂给右侧预览面板）；工作区之外时是原始绝对路径 */
	path: string;
	/** 文件名（chip 上显示这个，完整路径放 title） */
	name: string;
	/** 扩展名（小写，没扩展名是空串）——决定 chip 上的小徽标 */
	ext: string;
	/** 在工作区之外：预览面板读不了 */
	outside: boolean;
};

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

function extensionOf(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 折成相对工作区；不在工作区里的保持绝对路径并标记出来 */
function normalize(raw: string, root: string | null): { path: string; outside: boolean } {
	const clean = raw.trim();
	if (clean === "") return { path: "", outside: true };
	if (!clean.startsWith("/")) return { path: clean.replace(/^\.\//, ""), outside: false };
	if (root === null || root === "") return { path: clean, outside: true };
	const prefix = root.endsWith("/") ? root : `${root}/`;
	if (clean === root) return { path: "", outside: true };
	return clean.startsWith(prefix)
		? { path: clean.slice(prefix.length), outside: false }
		: { path: clean, outside: true };
}

/** 从参数对象里收集路径（对象自身 + `files` 数组两种写法） */
function collectPaths(value: unknown, out: string[], depth = 0): void {
	if (depth > 3 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectPaths(item, out, depth + 1);
		return;
	}
	const record = value as Record<string, unknown>;
	for (const key of PATH_KEYS) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim() !== "") out.push(candidate);
	}
	const files = record.files;
	if (Array.isArray(files)) collectPaths(files, out, depth + 1);
}

/** 一个工具块说它动了哪些文件 */
function toolPathsOf(block: ToolBlock): string[] {
	const raw = (block.argsFull ?? block.argsSummary ?? "").trim();
	if (raw === "") return [];
	const paths: string[] = [];
	try {
		collectPaths(JSON.parse(raw) as unknown, paths);
		return paths;
	} catch {
		// 参数被截断（`write` 写入几千字时 argsFull 也会被服务端截到 4000 字）→ JSON 解析不了，
		// 退化成从原文里抠 `"path":"…"`。**只取第一个**：pi 的 write / edit 里 path 都在最前，
		// 而截断之后正文里可能还带着别处抄来的 `"path"` 字样，取多了就会冒出假文件。
		const first = PATH_IN_TEXT.exec(raw)?.[1];
		if (first !== undefined) {
			try {
				paths.push(JSON.parse(`"${first}"`) as string);
			} catch {
				paths.push(first);
			}
		}
		return paths;
	}
}

/** 这条消息改过的文件（顺序 = 第一次出现的顺序，去重） */
export function changedFilesIn(message: UiMessage, root: string | null): ChangedFile[] {
	const out: ChangedFile[] = [];
	const seen = new Set<string>();
	for (const block of message.blocks) {
		if (block.kind !== "tool") continue;
		// 失败的不算改过；还在跑的先不算（这一刻文件还没落地）
		if (block.status !== "ok") continue;
		if (!EDIT_TOOL.test(block.name)) continue;
		for (const raw of toolPathsOf(block)) {
			const { path, outside } = normalize(raw, root);
			if (path === "" || seen.has(path)) continue;
			seen.add(path);
			out.push({ path, name: basename(path), ext: extensionOf(path), outside });
		}
	}
	return out;
}

/* ------------------------------------------------------------------------- */
/* 「消息里点的那个文件名」 → 「模型真的用过的那份绝对路径」                    */
/* ------------------------------------------------------------------------- */

/**
 * 会话里工具调用出现过的路径（按时间顺序，可能有重复）。
 *
 * 为什么要存一份：模型在正文里常只写文件名（「按规范先读 `query-workflows.md`」），
 * 而它读那个文件时给的**是绝对路径** —— 那份地址就在工具参数里。
 * 点链接时拿这份索引把真实地址找回来，比在界面上按文件名乱猜靠得住。
 */
type ToolPathUse = { path: string; name: string };

export function toolPathUses(messages: readonly UiMessage[]): ToolPathUse[] {
	const out: ToolPathUse[] = [];
	for (const message of messages) {
		for (const block of message.blocks) {
			if (block.kind !== "tool") continue;
			for (const path of toolPathsOf(block)) out.push({ path, name: basename(path) });
		}
	}
	return out;
}

/**
 * 纯函数：给消息里点的 token 找回真实路径；找不回返回 `null`（就按原样去解析）。
 *
 * 三条纪律：
 *   - 只认**绝对路径**：相对路径还原不了（cwd 只有服务端知道），别装懂；
 *   - 从后往前找：模型最后用过的那份，最可能就是它此刻在说的；
 *   - 先按「路径后缀」配，再退到「文件名」配 —— token 带目录时不能被同名的别处文件骗走。
 */
export function realPathForToken(token: string, uses: readonly ToolPathUse[]): string | null {
	const wanted = token.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (wanted === "" || wanted.startsWith("/")) return null;
	const absolute = uses.filter((use) => use.path.startsWith("/"));
	const bySuffix = [...absolute].reverse().find((use) => use.path === wanted || use.path.endsWith(`/${wanted}`));
	if (bySuffix) return bySuffix.path;
	const byName = [...absolute].reverse().find((use) => use.name === wanted);
	return byName?.path ?? null;
}
