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

export function useFileSearch(root: string | null): FileSearch {
	const [active, setActive] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FileSearchEntry[]>(EMPTY);
	const [truncated, setTruncated] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// 输入停下来 250ms 再查（边打边发请求没必要）
	useEffect(() => {
		if (!active || !root) return;
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
