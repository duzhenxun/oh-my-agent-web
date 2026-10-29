/**
 * 文件树的 git 状态（M / A / U …）与目录聚合。
 *
 * 为什么要「按目录聚合」：文件树是懒加载的 —— 只展开了 `web/src` 时，树里根本没有
 * 子文件的那些行；但用户需要知道「这个文件夹里有改动」。所以这里把每条状态按路径前缀
 * 往上卷一层（`web/src/a.ts` → `web`、`web/src` 都算有改动），目录行据此染色 + 打点。
 */
import { useEffect, useState } from "react";

export type FileStatusKind = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

export type FileStatusEntry = { status: FileStatusKind; added: number; removed: number };

type GitStatusMap = {
	isRepo: boolean;
	/** 相对工作区根的路径 → 状态 */
	entries: Record<string, FileStatusEntry>;
};

/** 状态 → 显示用的单字母（跟 git 的习惯一致） */
export const STATUS_LETTER: Record<FileStatusKind, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	untracked: "U",
	renamed: "R",
	conflicted: "!",
};

/**
 * 纯函数：目录 → 它下面有没有改动。
 * 返回「最重的那个状态」（冲突 > 删除 > 修改 > 新增），没有改动就 undefined。
 */
const SEVERITY: FileStatusKind[] = ["conflicted", "deleted", "modified", "renamed", "added", "untracked"];

export function foldStatusToDirs(entries: Record<string, FileStatusEntry>): Map<string, FileStatusKind> {
	const dirs = new Map<string, FileStatusKind>();
	for (const [path, entry] of Object.entries(entries)) {
		const parts = path.split("/");
		// 逐级往上：a/b/c.ts → a/b、a
		for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
			const dir = parts.slice(0, depth).join("/");
			const current = dirs.get(dir);
			if (current === undefined || SEVERITY.indexOf(entry.status) < SEVERITY.indexOf(current)) {
				dirs.set(dir, entry.status);
			}
		}
	}
	return dirs;
}

/**
 * 拉一次状态表。`revision` 变化（换项目 / 换分支 / 点刷新）就重拉；
 * `running` 从「在跑」变成「空闲」也重拉一次 —— 智能体刚改完文件，树上的 M 得跟着出现。
 */
export function useGitStatus(root: string | null, revision: string, running: boolean): GitStatusMap {
	const [status, setStatus] = useState<GitStatusMap>({ isRepo: false, entries: {} });
	const [finishedAt, setFinishedAt] = useState(0);
	// 回合结束（true → false）时记一笔，作为重新拉取的触发条件之一
	const [wasRunning, setWasRunning] = useState(running);
	if (wasRunning !== running) {
		setWasRunning(running);
		if (wasRunning) setFinishedAt((value) => value + 1);
	}

	useEffect(() => {
		if (!root) {
			setStatus({ isRepo: false, entries: {} });
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const response = await fetch(`/api/files/git/status?root=${encodeURIComponent(root)}`);
				if (cancelled) return;
				if (!response.ok) {
					// 404 通常是「服务端还在跑旧构建」（这条路由是后加的）：留一条警告，
					// 否则界面上只是「没有标记」，根本看不出是接口没了。
					console.warn(`[git status] ${response.status} — 服务端可能还在跑旧版本，重启一次即可`);
					setStatus({ isRepo: false, entries: {} });
					return;
				}
				setStatus((await response.json()) as GitStatusMap);
			} catch {
				if (!cancelled) setStatus({ isRepo: false, entries: {} });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [root, revision, finishedAt]);

	return status;
}
