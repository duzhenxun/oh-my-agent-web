/**
 * 「@ 提及」的候选来源：工作区文件名搜索（服务端 `/api/files/search`）+ 最近用过的路径。
 *
 * 和 `useFileSearch.ts`（文件管理侧栏那把 🔍）**故意不共用**：
 *   - 那个是常驻搜索框，一次能翻 200 条、没有键盘选择；
 *   - 这个是输入框里的补全，输入停下来才查、结果最多几十条，还要记住「最近挑过谁」。
 * 两边的状态生命周期不一样，硬塞进一个 hook 只会让两边都别扭。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MentionRecent } from "./at-mentions.ts";

/** 边打边发改成「停下来再发」：每敲一个字母都发请求，本地服务也扛不住几十毫秒一次 */
const SEARCH_DEBOUNCE_MS = 180;

/** 记最近用过的路径（跨会话、跨刷新）：第二次想引用同一个文件时少走一趟搜索 */
const RECENT_KEY = "agent-web:mention-recent";
/** 一共存几条（含别的项目的）：每个项目各留几条，换回来时还在 */
const RECENT_STORED_MAX = 24;

type StoredRecent = MentionRecent & { root: string };

const EMPTY: MentionRecent[] = [];

function readStored(): StoredRecent[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is StoredRecent => {
				if (typeof item !== "object" || item === null) return false;
				const record = item as Record<string, unknown>;
				return typeof record.root === "string" && typeof record.path === "string";
			})
			.map((item) => ({ root: item.root, path: item.path, isDir: item.isDir === true }));
	} catch {
		return []; // 脏数据（手改过 / 老版本）：当作没有，不弹错
	}
}

export type FileMention = {
	/** 搜索命中（相对工作区根的路径） */
	results: MentionRecent[];
	/** 当前项目里最近引用过的路径（新的在前） */
	recent: MentionRecent[];
	loading: boolean;
	/** 搜索失败时的一句话（没工作区 / 接口出错）；正常搜索无命中不是错误 */
	error: string | null;
	/** 记住一个刚用过的路径（插入草稿时调用） */
	remember: (item: MentionRecent) => void;
};

/**
 * `term` 传 `null` = 面板没开着（顺手把上一轮结果清掉，下次打开不会闪一下旧候选）。
 */
/** 名字以关键字开头 = 0（更可能是想找的那个），只是包含 = 1 */
function rankName(name: string, prefix: string): number {
	return name.toLowerCase().startsWith(prefix) ? 0 : 1;
}

export function useFileMention(root: string | null, term: string | null): FileMention {
	const [results, setResults] = useState<MentionRecent[]>(EMPTY);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stored, setStored] = useState<StoredRecent[]>(readStored);

	useEffect(() => {
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(stored));
		} catch {
			// 私密模式 / 配额满：记住「最近」只是锦上添花，写不进去就算了
		}
	}, [stored]);

	/** 「最近」按项目分开记（相对路径只在它自己那个根下才成立） */
	const rootKey = root ?? "";

	const recent = useMemo(
		() => stored.filter((item) => item.root === rootKey).map(({ path, isDir }) => ({ path, isDir })),
		[stored, rootKey],
	);

	const remember = useCallback(
		(item: MentionRecent) => {
			setStored((current) => {
				const rest = current.filter((entry) => !(entry.root === rootKey && entry.path === item.path));
				return [{ root: rootKey, path: item.path, isDir: item.isDir }, ...rest].slice(0, RECENT_STORED_MAX);
			});
		},
		[rootKey],
	);

	useEffect(() => {
		const needle = (term ?? "").trim();
		if (term === null || !root || needle === "") {
			setResults(EMPTY);
			setLoading(false);
			setError(null);
			return;
		}
		/*
		 * 带 `/` 的关键字 = 用户在按目录缩小范围（`@web-push/ser`）。
		 * 服务端只按**文件名**匹配，所以先拿最后一段去搜，再拿整条路径过一遍 ——
		 * 这样 `@web-push/` 这种纯目录前缀也不会把整个工作区的同名文件全列出来。
		 */
		const slash = Math.max(needle.lastIndexOf("/"), needle.lastIndexOf("\\"));
		const query = slash >= 0 ? needle.slice(slash + 1) : needle;
		if (query === "") {
			setResults(EMPTY);
			setLoading(false);
			setError(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const response = await fetch(
						`/api/files/search?q=${encodeURIComponent(query)}&root=${encodeURIComponent(root)}`,
					);
					const body = (await response.json()) as {
						entries?: { name: string; path: string; isDir: boolean }[];
						error?: { message?: string };
					};
					if (cancelled) return;
					if (!response.ok) {
						setResults(EMPTY);
						setError(body.error?.message ?? `HTTP ${response.status}`);
						return;
					}
					const entries = body.entries ?? [];
					const hits =
						slash < 0 ? entries : entries.filter((entry) => entry.path.toLowerCase().includes(needle.toLowerCase()));
					/*
					 * 服务端是按广度优先吐的（浅层在前），于是 `@comp` 这种短词会把
					 * `apple-touch-icon-precomposed.png` 之类「只是包含」的文件排在真·`composer*` 前面。
					 * 这里稳定排序一次：**名字以关键字开头**的优先，同档内保持原来的浅层优先。
					 */
					const prefix = query.toLowerCase();
					const ranked = [...hits].sort((a, b) => rankName(a.name, prefix) - rankName(b.name, prefix));
					setResults(ranked.map((entry) => ({ path: entry.path, isDir: entry.isDir === true })));
					setError(null);
				} catch (cause) {
					if (cancelled) return;
					setResults(EMPTY);
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			setLoading(false);
		};
	}, [root, term]);

	return { results, recent, loading, error, remember };
}
