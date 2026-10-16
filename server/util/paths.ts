/**
 * 路径解析与约束（纯函数）。
 *
 * 两个场景用它：
 *   1. `web/dist` 在哪 —— 源码运行与编译运行的层数不同（M1 踩过）；
 *   2. 路径是否落在工作区内 —— ADR-0006：`realpath` 之后必须在根内（防 `..` 与 symlink 逃逸）。
 *
 * 刻意把 `realpath` 作为参数注入：单测不需要造文件系统，调用方传 `fs.realpathSync`。
 */
import { join, relative, resolve, sep } from "node:path";

export function pickExisting(candidates: string[], exists: (path: string) => boolean): string | null {
	for (const candidate of candidates) if (exists(candidate)) return candidate;
	return null;
}

/** web/dist 的候选路径：先是「源码运行」，再是「编译后运行」 */
export function webDistCandidates(serverDir: string): string[] {
	return [join(serverDir, "..", "web", "dist"), join(serverDir, "..", "..", "web", "dist")];
}

/**
 * `candidate` 是否在 `root` 之内。
 *
 * 用「相对路径不以 `..` 开头」判断，而不是字符串 `startsWith`：
 * `/root2` 不是 `/root` 的子路径，但 `startsWith("/root")` 会误判为真。
 * 传入的路径应当是**已经 realpath 过**的（调用方负责），否则 symlink 能逃出去。
 */
export function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	if (relativePath === "") return true; // 就是根本身
	return !relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`) && !isAbsoluteLike(relativePath);
}

function isAbsoluteLike(path: string): boolean {
	return path.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 解析到真实路径并确认在工作区内（ADR-0006）。
 * `realpath` 失败（路径不存在）时按「不在根内」处理 —— 宁可拒绝，不要放行。
 */
export function resolveInsideRoot(
	root: string,
	candidate: string,
	realpath: (path: string) => string,
): { ok: true; path: string } | { ok: false; reason: string } {
	let realRoot: string;
	try {
		realRoot = realpath(root);
	} catch {
		return { ok: false, reason: `工作区根无法解析：${root}` };
	}
	let realCandidate: string;
	try {
		realCandidate = realpath(candidate);
	} catch {
		return { ok: false, reason: `路径不存在或无法解析：${candidate}` };
	}
	if (!isPathInside(realRoot, realCandidate)) {
		return { ok: false, reason: `路径越界（不在工作区内）：${candidate}` };
	}
	return { ok: true, path: realCandidate };
}
