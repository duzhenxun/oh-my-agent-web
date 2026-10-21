/**
 * 文件名搜索（文件管理标题栏的放大镜）。
 *
 * 只按**文件名**匹配（不做内容搜索：那是 grep 的活，也不该把大仓库全读一遍）。
 * 约束：只在工作区根内、跳过 node_modules/.git 等重目录、深度与结果数都有上限 ——
 * 单用户工作台里「点了没反应」比「慢一点」更难受，所以宁可少返回也要快。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_ENTRIES, type FileEntry } from "./file-service.js";

export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_MAX_DEPTH = 8;

export type SearchResult = { ok: true; entries: FileEntry[]; truncated: boolean } | { ok: false; error: string };

/** 纯函数：名字是否命中（大小写不敏感的包含匹配） */
export function matchesQuery(name: string, query: string): boolean {
	return name.toLowerCase().includes(query.toLowerCase());
}

export async function searchFiles(
	root: string,
	query: string,
	options: { maxResults?: number; maxDepth?: number } = {},
): Promise<SearchResult> {
	const needle = query.trim();
	if (needle === "") return { ok: true, entries: [], truncated: false };
	const maxResults = options.maxResults ?? SEARCH_MAX_RESULTS;
	const maxDepth = options.maxDepth ?? SEARCH_MAX_DEPTH;
	const found: FileEntry[] = [];
	let truncated = false;

	/** 广度优先一层层扫：先命中的是浅层文件，视觉上更符合预期 */
	const walk = async (dir: string, relPath: string, depth: number): Promise<void> => {
		if (depth > maxDepth || found.length >= maxResults) {
			truncated ||= found.length >= maxResults;
			return;
		}
		let items;
		try {
			items = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 没权限 / 刚被删：跳过
		}
		const dirs: { path: string; rel: string }[] = [];
		for (const item of items) {
			if (IGNORED_ENTRIES.has(item.name)) continue;
			if (found.length >= maxResults) {
				truncated = true;
				return;
			}
			const childPath = join(dir, item.name);
			const childRel = join(relPath, item.name);
			if (item.isDirectory()) dirs.push({ path: childPath, rel: childRel });
			if (matchesQuery(item.name, needle)) found.push({ name: item.name, path: childRel, isDir: item.isDirectory() });
		}
		for (const dir2 of dirs) await walk(dir2.path, dir2.rel, depth + 1);
	};

	try {
		await walk(root, "", 0);
		return { ok: true, entries: found, truncated };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
