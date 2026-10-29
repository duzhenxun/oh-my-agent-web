/**
 * 「文件管理」的按文件名搜索状态（FilesToolbar 的 🔍 按钮 + 下拉框下面那个搜索框共用一份）。
 *
 * 抽成 hook 的原因：搜索框要渲染在「项目下拉框」下面、结果列表要顶替文件树，
 * 而开关按钮在标题栏那一排 —— 状态得放在两者共同的父级（SidebarFiles）。
 *
 * 搜索走服务端 `/api/files/search`（只匹配文件名，不读内容）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type FileSearchEntry = { name: string; path: string; isDir: boolean };

export type FileSearch = {
	/** 搜索框是否展开 */
	active: boolean;
	query: string;
	results: FileSearchEntry[];
	truncated: boolean;
	inputRef: React.RefObject<HTMLInputElement | null>;
	setQuery: (value: string) => void;
	/** 点标题栏那个 🔍：开/关搜索框（开的时候清空上一轮关键字） */
	toggle: () => void;
	/** 关掉并清空（Esc、收起文件区时用） */
	close: () => void;
};

const EMPTY: FileSearchEntry[] = [];

type UseFileSearchOptions = {
	/** 常驻筛选：不靠 `active` 也能查（右侧面板那根文件侧栏用） */
	always?: boolean;
};

export function useFileSearch(root: string | null, options?: UseFileSearchOptions): FileSearch {
	const [active, setActive] = useState(false);
	/**
	 * 常驻模式：有输入框就一直能筛（右侧面板那根文件侧栏），不需要先点 🔍 展开。
	 * 侧栏的 ⚙ 开关只管开不开侧栏，不兼职搜索的开关。
	 */
	const always = options?.always === true;
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FileSearchEntry[]>(EMPTY);
	const [truncated, setTruncated] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// 输入停下来 250ms 再查（边打边发请求没必要）
	useEffect(() => {
		if (!(always || active) || !root) return;
		const needle = query.trim();
		if (needle === "") {
			setResults(EMPTY);
			setTruncated(false);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const response = await fetch(
						`/api/files/search?q=${encodeURIComponent(needle)}&root=${encodeURIComponent(root)}`,
					);
					const body = (await response.json()) as { entries?: FileSearchEntry[]; truncated?: boolean };
					if (cancelled) return;
					setResults(body.entries ?? EMPTY);
					setTruncated(body.truncated === true);
				} catch {
					if (cancelled) return;
					setResults(EMPTY);
				}
			})();
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [active, query, root]);

	// 换项目/关掉搜索后别留上一轮的残留
	useEffect(() => {
		if (!root) setResults(EMPTY);
	}, [root]);

	useEffect(() => {
		// 只给 🔍 展开那种用：常驻侧栏不抢焦点（否则一开文件光标就跳进筛选框）
		if (active) inputRef.current?.focus();
	}, [active]);

	const close = useCallback(() => {
		setActive(false);
		setQuery("");
		setResults(EMPTY);
		setTruncated(false);
	}, []);

	const toggle = useCallback(() => {
		setActive((value) => !value);
		setQuery("");
		setResults(EMPTY);
		setTruncated(false);
	}, []);

	return { active, query, results, truncated, inputRef, setQuery, toggle, close };
}
