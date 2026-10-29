import { useEffect, useRef, useState } from "react";
import { useT } from "../use-language.ts";
import {
	SEARCH_SIZE_KEY,
	type SearchSize,
	clampSearchSize,
	growSearchSize,
	parseStoredSearchSize,
} from "../content-search-size.ts";

/** `/api/files/grep` 的一条命中（对照 server/files/content-search.ts 的 ContentMatch） */
type ContentHit = {
	path: string;
	line: number;
	text: string;
	/** 命中在 text 里的起始列（服务端算好的，界面照着加高亮） */
	column: number;
};

type GrepBody = { matches?: ContentHit[]; truncated?: boolean; error?: { message?: string } };

/**
 * 解析 `/api/files/grep` 的回包。
 *
 * 为什么不用 `response.json()`：服务端要是**还没有这个路由**（比如新界面配着旧的 server 进程），
 * 请求会落到单页应用的兜底上、回一段 `<!DOCTYPE html>`，
 * 直接 parse 就会抛 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` ——
 * 用户看到的就是一句跟「搜索」毫无关系的报错（截图里正是这个）。
 * 这里解析不出来就回 null，由调用方换成「服务端大概是旧进程，重启一次」。
 */
function parseGrepBody(raw: string): GrepBody | null {
	try {
		const value = JSON.parse(raw) as unknown;
		return value !== null && typeof value === "object" ? (value as GrepBody) : null;
	} catch {
		return null;
	}
}

/** 输入停下来多久再发请求（边打边发只会把服务端扫盘排队） */
const DEBOUNCE_MS = 250;

/**
 * 全文搜索（**文件内容**搜索）—— 顶栏那面放大镜 / `⌘⇧F`（Windows 上 `Ctrl+Shift+F`）打开。
 *
 * 与文件树的 🔍 分工：那个按**文件名**找「哪个文件」，这个按**内容**找「哪一行」——
 * 「这句文案写在哪」属于后者。
 *
 * 交互沿用编辑器那套：
 *   - 上面一行两个输入：关键字 + 文件掩码（`*.ts`，空则不筛）；
 *   - 结果一行一条命中：左边是那一行的原文（命中处高亮），右边是 `路径:行号`；
 *   - `↑`/`↓` 换一条，`Enter` 打开那条（右侧面板跳到那一行），`Esc` 关掉。
 *
 * 结果**不做分页**：服务端有上限（200 条），到上限就明说「只显示前 N 条」——
 * 一个搜索框最怕的是「看着像没结果，其实是没显示完」。
 */
export function ContentSearch({
	open,
	root,
	onClose,
	onOpen,
}: {
	open: boolean;
	root: string | null;
	onClose: () => void;
	/** 打开某条命中：右侧面板开这个文件并跳到第 `line` 行 */
	onOpen: (path: string, line: number) => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [glob, setGlob] = useState("");
	const [hits, setHits] = useState<ContentHit[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [cursor, setCursor] = useState(0);
	/**
	 * 输入法正在组字（打中文 / 日文时的拼音候选阶段）。
	 * 组字期间既不该发请求（`gongn` 这种半截拼音搜出来必然空），也不该收 Enter / ↑↓ ——
	 * 那几个键这时候属于候选词窗口，抢过来会变成「打中文按回车结果打开了一个文件」。
	 */
	const [composing, setComposing] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 弹层尺寸：`null` = 用 CSS 默认值（默认比原来宽一截，见 content-search-size.ts）。
	 * 拖过右下角抓手就记下来，存 localStorage，下次打开还是那个大小。
	 */
	const [size, setSize] = useState<SearchSize | null>(() => {
		try {
			return parseStoredSearchSize(localStorage.getItem(SEARCH_SIZE_KEY));
		} catch {
			return null; // 隐私模式读不了 localStorage：用默认尺寸，不抛错
		}
	});
	/** 拖动中的起点 + 起始尺寸（松手才写 localStorage，不每次 move 都写） */
	const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
	const sizeRef = useRef<SearchSize | null>(size);
	const [resizing, setResizing] = useState(false);
	const panelRef = useRef<HTMLDivElement | null>(null);

	const applySize = (next: SearchSize | null) => {
		sizeRef.current = next;
		setSize(next);
	};

	// 每次打开都把光标放进关键字框（上一次的关键字留着：多半是「改几个字再搜一遍」）
	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open]);

	// 关键字 / 掩码变化 → 防抖查一次
	useEffect(() => {
		if (!open || !root) return;
		if (composing) return;
		const needle = query.trim();
		if (needle === "") {
			setHits([]);
			setTruncated(false);
			setError(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const params = new URLSearchParams({ q: needle, root, glob });
					const response = await fetch(`/api/files/grep?${params}`);
					// **先当文本读，再自己 parse**（见 parseGrepBody 的注释）：旧服务端会回一段 HTML
					const body = parseGrepBody(await response.text());
					if (cancelled) return;
					if (body === null) {
						setHits([]);
						setTruncated(false);
						setCursor(0);
						setError(
							t(
								"搜索接口没有返回数据（服务端大概是旧进程）：重启一次 oh-my-agent-web 再试",
								"The search endpoint returned no JSON (the server is probably an older build): restart oh-my-agent-web and retry",
							),
						);
						return;
					}
					setHits(body.matches ?? []);
					setTruncated(body.truncated === true);
					setError(response.ok ? null : (body.error?.message ?? t("搜索失败", "Search failed")));
					setCursor(0);
				} catch (cause) {
					if (cancelled) return;
					setHits([]);
					setTruncated(false);
					setError(cause instanceof Error ? cause.message : t("搜索失败", "Search failed"));
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, query, glob, root, t, composing]);

	// 换了搜索根（「文件 ▾」下拉框切了项目）→ 立刻清掉上一轮的结果：
	// 不然新项目还在扫的时候，列表里摆的是**另一个项目**的行，点一下就会打开错的文件。
	// 关键字不清：多半是「换个项目再搜一遍同一个词」。
	useEffect(() => {
		setHits([]);
		setTruncated(false);
		setError(null);
		setCursor(0);
	}, [root]);

	// 换选中的那条 → 把它滚进可见区（结果多的时候键盘换行不至于跑到屏幕外）
	useEffect(() => {
		if (!open) return;
		const row = listRef.current?.querySelector<HTMLElement>(`[data-hit="${cursor}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [cursor, open, hits]);

	if (!open) return null;

	const pick = (hit: ContentHit | undefined) => {
		if (!hit) return;
		onOpen(hit.path, hit.line);
		onClose();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		// 组字中（或刚结束那一帧）不接管键盘：Enter 是「确认候选词」，↑↓ 是「翻候选页」
		if (composing || event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (hits.length === 0) return;
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setCursor((current) => (current + delta + hits.length) % hits.length);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			pick(hits[cursor]);
		}
	};

	const needle = query.trim();
	/**
	 * 抓手拖动：起点尺寸取自**当时的实际渲染尺寸**（没拖过时高度是内容撑的，不是某个常数），
	 * 之后每一下都按「起始尺寸 + 位移」重算，不做累加 —— 中途被夹取过也不会越拖越偏。
	 */
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		const panel = panelRef.current;
		if (!panel) return;
		event.preventDefault();
		const rect = panel.getBoundingClientRect();
		dragRef.current = { x: event.clientX, y: event.clientY, w: rect.width, h: rect.height };
		setResizing(true);
		// 抓住指针：鼠标拖出 16px 的抓手（甚至拖出窗口）也继续收到 move
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};

	const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		applySize(
			growSearchSize({ w: drag.w, h: drag.h }, event.clientX - drag.x, event.clientY - drag.y, {
				width: window.innerWidth,
				height: window.innerHeight,
			}),
		);
	};

	const endResize = () => {
		if (!dragRef.current) return;
		dragRef.current = null;
		setResizing(false);
		try {
			const next = sizeRef.current;
			if (next) localStorage.setItem(SEARCH_SIZE_KEY, JSON.stringify(next));
			else localStorage.removeItem(SEARCH_SIZE_KEY);
		} catch {
			// 隐私模式写不进去：本次会话内照样能拖，只是下回打开回默认
		}
	};

	// 窗口被拉小以后，上次记下的尺寸可能已经放不下了 —— 渲染时再夹一次（不写回存储）
	const fitted = size === null ? null : clampSearchSize(size, { width: window.innerWidth, height: window.innerHeight });
	const panelStyle = fitted === null ? undefined : { width: fitted.w, height: fitted.h, maxHeight: "none" };

	const status =
		needle === ""
			? t("输入关键字，搜工作区里的文件内容", "Type to search file contents in the workspace")
			: // 出错时只留上面那条错误：底下再写一句「没有匹配的行」容易让人以为「搜了但真没有」
				error
				? ""
				: loading
					? t("搜索中…", "Searching…")
					: hits.length === 0
						? t("没有匹配的行", "No matching lines")
						: `${t(`${hits.length} 条结果`, `${hits.length} results`)}${
								truncated ? t("（只显示前若干条，换个更具体的关键字）", " (first results only — narrow the query)") : ""
							}`;

	return (
		<div
			className="content-search-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("搜索文件内容", "Search file contents")}
			onKeyDown={onKeyDown}
			// 点灰底 = 关（点面板里面不算）
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className={`content-search${resizing ? " content-search-resizing" : ""}`} ref={panelRef} style={panelStyle}>
				<div className="content-search-head">
					<input
						ref={inputRef}
						className="content-search-input"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onCompositionStart={() => setComposing(true)}
						onCompositionEnd={(event) => {
							setComposing(false);
							// 组字结束时 value 才包含最终候选词，补同步一次（否则要再敲一个键才搜）
							setQuery(event.currentTarget.value);
						}}
						placeholder={t("搜索文件内容…", "Search file contents…")}
						aria-label={t("关键字", "Query")}
						spellCheck={false}
					/>
					<input
						className="content-search-glob mono"
						value={glob}
						onChange={(event) => setGlob(event.target.value)}
						placeholder={t("文件掩码，如 *.ts", "File mask, e.g. *.ts")}
						aria-label={t("文件掩码", "File mask")}
						title={t(
							"只看匹配的文件：`*.ts` 看文件名，`src/**/*.go` 看路径，留空则搜全部",
							"Limit to matching files: `*.ts` matches names, `src/**/*.go` matches paths, empty = all",
						)}
						spellCheck={false}
					/>
					<kbd className="content-search-esc">Esc</kbd>
				</div>
				{error ? <div className="content-search-error">{error}</div> : null}
				<div className="content-search-list" ref={listRef}>
					{hits.map((hit, index) => (
						<button
							type="button"
							key={`${hit.path}:${hit.line}`}
							data-hit={index}
							className={`content-search-row${index === cursor ? " content-search-row-on" : ""}`}
							onClick={() => pick(hit)}
							title={`${hit.path}:${hit.line}`}
							onMouseMove={() => {
								if (index !== cursor) setCursor(index);
							}}
						>
							<span className="content-search-line mono">{renderHit(hit, needle)}</span>
							{/* 路径**整条显示、不掐中间**（用户明确要求）：服务端给的 `hit.path` 就是
							    「以当前项目根为基准」的相对路径，原样铺出来就是「项目 → 文件」的全路径。
							    以前这里过一道 `shortPath()`（中间换 …），十几条看着全是一串省略号 —— 就是用户报的那个问题。
							    现在改成「路径优先吃宽度，太长就换行」（见 content-search.css）。
							    注意：**以后若再想截断，也不要用 CSS `direction: rtl`** —— 那套会把开头的 .
							    （`.run/qa/…`）倒排到末尾，看着像文件名后面多了个句号（曾经的 bug）。 */}
							<span className="content-search-where mono">
								{hit.path}:{hit.line}
							</span>
						</button>
					))}
				</div>
				<div className="content-search-foot">
					<span className="content-search-status">{status}</span>
					<span className="content-search-keys">
						<kbd>↑</kbd>
						<kbd>↓</kbd> {t("切换结果", "switch")}
						<kbd>⏎</kbd> {t("打开", "open")}
					</span>
				</div>
				{/* 右下角的抓手：按住拖 = 改大小，双击 = 复位到默认尺寸
				    （复位 = 清掉记录、回到 CSS 默认，不必再拄一份默认值） */}
				<div
					className="content-search-grip"
					aria-hidden="true"
					title={t("拖动调整大小（双击复位）", "Drag to resize (double-click to reset)")}
					onPointerDown={startResize}
					onPointerMove={moveResize}
					onPointerUp={endResize}
					onPointerCancel={endResize}
					onDoubleClick={() => applySize(null)}
				/>
			</div>
		</div>
	);
}

/** 命中那一段套一层 <mark>：其余部分原样输出（行文本是纯文本，不解析 markdown） */
function renderHit(hit: ContentHit, needle: string) {
	if (needle === "" || hit.column < 0) return hit.text;
	const end = hit.column + needle.length;
	return (
		<>
			{hit.text.slice(0, hit.column)}
			<mark className="content-search-mark">{hit.text.slice(hit.column, end)}</mark>
			{hit.text.slice(end)}
		</>
	);
}
