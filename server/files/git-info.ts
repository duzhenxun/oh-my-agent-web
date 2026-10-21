/**
 * 当前项目的 git 分支（文件管理标题栏显示「⎇ main」那种）。
 *
 * 直接读 `.git/HEAD` 而不是 shell 出去跑 git：
 *   - 不用 spawn 进程、不会因为仓库损坏而卡住；
 *   - 只读一个几十字节的文件，也不需要 git 装在某处。
 * 兼容 `.git` 是**文件**的情况（worktree / submodule 里 `.git` 指向别处）。
 */
import { readFile, stat } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";

/** 纯函数：把 HEAD 内容解析成分支名（detached 时返回短 hash） */
export function parseHead(content: string): string | null {
	const text = content.trim();
	if (text === "") return null;
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref?.[1]) return ref[1];
	// detached HEAD：直接是 40 位 sha，取前 7 位够认
	return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7) : null;
}

export type GitInfo = { branch: string | null; isRepo: boolean };

export async function readGitInfo(root: string): Promise<GitInfo> {
	// 从工作区往上找 .git（工作区可能是仓库的子目录）
	let dir = resolve(root);
	for (let depth = 0; depth < 6; depth += 1) {
		const gitPath = join(dir, ".git");
		try {
			const info = await stat(gitPath);
			const headPath = info.isDirectory() ? join(gitPath, "HEAD") : await worktreeHead(gitPath);
			if (!headPath) return { branch: null, isRepo: false };
			return { branch: parseHead(await readFile(headPath, "utf8")), isRepo: true };
		} catch {
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return { branch: null, isRepo: false };
}

/** `.git` 是文件时内容形如 `gitdir: /path/to/repo/.git/worktrees/x` */
async function worktreeHead(gitFile: string): Promise<string | null> {
	try {
		const content = (await readFile(gitFile, "utf8")).trim();
		const match = /^gitdir:\s*(.+)$/.exec(content);
		if (!match?.[1]) return null;
		const target = isAbsolute(match[1]) ? match[1] : resolve(join(gitFile, ".."), match[1]);
		return join(target, "HEAD");
	} catch {
		return null;
	}
}
