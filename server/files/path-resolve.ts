/**
 * 「用户点的那个路径」→「工作区里真实的那个文件」。
 *
 * 为什么需要这一层：对话里的文件链接不是完整路径 —— 模型写的是它**眼里的**路径，
 * 常见三种形态，以前只有第一种能打开，另外两种一律报「路径不存在或无法解析」：
 *
 *   1. `internal/cron/cron.go`（相对工作区）—— 一直好使；
 *   2. `/Users/me/proj/internal/cron/cron.go`（绝对路径）—— 被 `join(root, …)` 拼成
 *      `root + /Users/me/…`，必然不存在（agent 的报告、`read`/`write` 的参数都爱写绝对路径）；
 *   3. `cron.go`（只有文件名，模型顺口这么写）—— 现实文件在某个子目录里，也必然不存在。
 *
 * 所以统一在这里解析一次，再交给只吃相对路径的预览接口：
 *   - 绝对路径能落回工作区 → 换成相对路径（标签 id / diff / 行号都按相对路径记）；
 *   - 相对路径原样存在 → 直接用；
 *   - 找不到 → 按「路径后缀 / 文件名」在工作区里找一遍：**唯一命中就直接开**，
 *     多个命中返回候选让界面挑（不猜，猜错了比报错更难受）。
 */
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { normalize as posixNormalize } from "node:path/posix";
import { isEscapePath, resolveInsideRoot, toPosixPath } from "../util/paths.js";
import { isIgnoredEntry } from "./file-service.js";
import { listRepoFiles } from "./git-info.js";

/** 候选最多列几个（再多界面也读不过来，且用户多半要回去自己找） */
const MAX_CANDIDATES = 8;
/** 扫盘兜底时的文件数上限（非 git 工作区才会走到） */
const MAX_SCAN_FILES = 20000;
/** 扫盘兜底时的目录深度上限（node_modules 之类已经被 IGNORED 挡掉了） */
const MAX_SCAN_DEPTH = 12;

type TargetResolution =
	| {
			ok: true;
			/** 真实路径（realpath 之后，含符号链接解析） */
			path: string;
			/** 相对工作区的路径（`/` 分隔）：喂给预览接口、也当标签的身份 */
			relPath: string;
			/** 不是按原路径打开的：`suffix` = 按文件名/后缀在工作区里找到的唯一匹配 */
			matchedBy?: "suffix";
			/** 解析到的文件不在当前工作区里（模型读过的 skill 文档 / 别的仓库）：预览照开，但文件树里找不到它 */
			outsideRoot?: true;
	  }
	| { ok: false; error: string; candidates?: string[] };

/** 纯函数：把用户给的路径收拾成「相对、`/` 分隔」的形状（只做字符串层面的事） */
function normalizeWanted(raw: string): string {
	// Windows 风格的 `a\b\c.go` 先统一成 `/`；`posixNormalize` 再吃掉 `./` 与 `a/b/../c` 这类赘余
	const unified = toPosixPath(raw.trim().replace(/\\/g, "/")).replace(/^\/+/, "");
	if (unified === "") return "";
	return posixNormalize(unified).replace(/^\.\//, "");
}

/**
 * 纯函数：从工作区文件清单里挑出「像用户点的那个」的候选。
 *
 * 匹配口径：路径完全相同、或以 `/<wanted>` 结尾（后者已经覆盖了「只给文件名」——
 * `cron.go` 就是 `/cron.go` 那个后缀）。先按大小写敏感找，一个都没有再放宽大小写
 * （模型把 `Cron.go` 写成 `cron.go` 时不必让用户自己纠）。
 * 排序：完全一致 → 层级浅 → 字母序（浅的那个通常是模型真正在说的）。
 */
function rankSuffixMatches(files: readonly string[], rawWanted: string, limit = MAX_CANDIDATES): string[] {
	const wanted = normalizeWanted(rawWanted);
	if (wanted === "") return [];
	const pick = (caseSensitive: boolean): string[] => {
		const needle = caseSensitive ? wanted : wanted.toLowerCase();
		const suffix = `/${needle}`;
		const hits: string[] = [];
		for (const file of files) {
			const value = caseSensitive ? file : file.toLowerCase();
			if (value === needle || value.endsWith(suffix)) hits.push(file);
		}
		return hits;
	};
	const hits = pick(true);
	const matched = hits.length > 0 ? hits : pick(false);
	return [...new Set(matched)]
		.sort((a, b) => {
			const exact = Number(b === wanted) - Number(a === wanted);
			if (exact !== 0) return exact;
			const depth = a.split("/").length - b.split("/").length;
			return depth !== 0 ? depth : a.localeCompare(b);
		})
		.slice(0, limit);
}

/** 工作区里的文件清单（`/` 分隔、相对工作区）：git 仓库问 git，其余才真的扫盘 */
async function listWorkspaceFiles(root: string): Promise<string[]> {
	const listed = await listRepoFiles(root, MAX_SCAN_FILES);
	if (listed) {
		const out: string[] = [];
		for (const file of listed.files) {
			const rel = relative(root, join(listed.repo, file));
			if (rel === "" || isEscapePath(rel)) continue;
			out.push(toPosixPath(rel));
		}
		return out;
	}
	return walkWorkspaceFiles(root);
}

/** 非 git 工作区的兜底：广度优先扫一层层，命中上限就停（只为了找候选，不求完整） */
async function walkWorkspaceFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
	while (queue.length > 0 && out.length < MAX_SCAN_FILES) {
		const current = queue.shift();
		if (!current) break;
		let items;
		try {
			items = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue; // 没权限 / 刚被删：跳过这一层
		}
		for (const item of items) {
			if (isIgnoredEntry(item.name) || item.name.startsWith(".")) continue;
			const rel = current.rel === "" ? item.name : `${current.rel}/${item.name}`;
			if (item.isDirectory()) {
				if (current.depth < MAX_SCAN_DEPTH) {
					queue.push({ dir: join(current.dir, item.name), rel, depth: current.depth + 1 });
				}
				continue;
			}
			out.push(rel);
			if (out.length >= MAX_SCAN_FILES) break;
		}
	}
	return out;
}

/** 工作区根的 realpath：macOS 上 `/var` → `/private/var`、`/tmp` 也是符号链接，不算这一层就会把「就在工作区里」判成越界 */
function realRootOf(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return root; // 根都 realpath 不了就交给后面的 resolveInsideRoot 报错
	}
}

/**
 * 解析一个「点开的路径」。失败时的 `error` 是给人看的一句话，
 * 有多个候选就一并带回去（界面列出来让用户点，而不是让他自己猜）。
 */
export async function resolveTarget(root: string, rawWanted: string): Promise<TargetResolution> {
	const wanted = rawWanted.trim();
	if (wanted === "") return { ok: false, error: "没有指定文件" };

	// `~/…`：模型偶尔按家目录写；先展开成绝对路径，后面就跟绝对路径一视同仁
	const expanded = wanted === "~" || wanted.startsWith("~/") ? join(homedir(), wanted.slice(1)) : wanted;

	// 1) 绝对路径：能映射进工作区就映射成相对路径（标签 id / diff 都按相对路径记）；
	//    在外面就按绝对路径直开 —— 那是工具参数里的真实地址，用户点的就是它
	if (isAbsolute(expanded)) {
		let real: string;
		try {
			real = realpathSync(expanded);
		} catch {
			return { ok: false, error: `路径不存在或无法解析：${wanted}` };
		}
		const rel = relative(realRootOf(root), real);
		if (rel === "" || isEscapePath(rel)) return { ok: true, path: real, relPath: real, outsideRoot: true };
		return { ok: true, path: real, relPath: toPosixPath(rel) };
	}

	// 2) 相对路径：先按原样试（正常情况走这条，零额外开销）
	const direct = resolveInsideRoot(root, join(root, wanted), realpathSync);
	if (direct.ok) {
		// 相对路径由真实路径反算：`a/b/../c.go` 与符号链接下的写法都归一化成同一个标签身份
		const directRel = toPosixPath(relative(realRootOf(root), direct.path));
		const relPath = directRel !== "" && !isEscapePath(directRel) ? directRel : normalizeWanted(wanted);
		return { ok: true, path: direct.path, relPath };
	}

	// 3) 不存在：按文件名 / 路径后缀在工作区里再找一遍
	const candidates = rankSuffixMatches(await listWorkspaceFiles(root), wanted);
	if (candidates.length === 1) {
		const only = candidates[0] ?? "";
		const resolved = resolveInsideRoot(root, join(root, only), realpathSync);
		if (resolved.ok) return { ok: true, path: resolved.path, relPath: only, matchedBy: "suffix" };
	}
	if (candidates.length > 1) {
		return { ok: false, error: `「${wanted}」对不上唯一文件，这些都能匹配：`, candidates };
	}
	return { ok: false, error: direct.reason };
}
