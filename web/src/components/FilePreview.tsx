import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	blockAt,
	blockFoldState,
	collapseBlock,
	codeSnippet,
	computeFolds,
	expandBlock,
	expandFoldsContaining,
	findInLines,
	firstLevelFolds,
	languageOf,
	referenceFor,
	referenceForSelection,
	toggleFolded,
	type FoldRange,
} from "../file-preview.ts";
import { useProgressiveHighlight } from "../progressive-highlight.ts";
import { getAppState, setDraft } from "../store.ts";
import { draggedSelection } from "../file-selection-dom.ts";
import { useLineSelection } from "../use-line-selection.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { useStoredNumber } from "../use-stored-number.ts";
import { PREVIEW_FONT_DEFAULT, PREVIEW_FONT_KEY, PREVIEW_FONT_MAX, PREVIEW_FONT_MIN, WRAP_KEY } from "../ui-prefs.ts";
import type { FileDiffPayload } from "../file-diff.ts";
import { FileDiff } from "./FileDiff.tsx";
import { FileLines } from "./FileLines.tsx";
import { FileLineMenu, type FileLineMenuState } from "./FileLineMenu.tsx";
import { FileFindBar } from "./FileFindBar.tsx";
import { zoomIntent } from "../panel-zoom.ts";
import { Markdown } from "./Markdown.tsx";
import { useT } from "../use-language.ts";

/** 空数组常量：state 为空/二进制时复用它，保证依赖引用稳定（否则高亮 effect 每次都重跑） */
const EMPTY_LINES: string[] = [];

// 只注册用得到的语言（全量包 ~1MB，这里按需注册约 80KB）
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);

/**
 * 只读预览（M4）：
 *   - **语法高亮**（按扩展名选语言；超过 800 行退化成纯文本，避免卡顿）；
 *   - **点行号选中、Shift+点行号选范围** → 右键菜单里「追加第 N 行到对话」，写进输入框的是
 *     `@path:10-20` 这种**引用**，不注入文件内容（ADR-0002 的原则：只给路径引用，模型自己去 read 那几行）。
 *     顶部工具栏不再挂「第 N 行 / 添加到对话 / 清除」那一组：它跟行高亮、右键菜单是同一件事的
 *     第三个入口，白占一排宽度；选中了哪些行看行底色就知道，要动手右键即可。
 */
/**
 * 文件内容视图（从原来的 FilePreview 弹窗里抽出来）：
 * 只管「读文件 + 显示 + 行选中」，不再管外壳（弹窗 or 右侧面板）。
 * `toolbar` 由外壳决定放什么按钮（关闭 / 全屏 / 标签…）。
 */
export function FileViewer({
	path,
	root,
	toolbar,
	initialMode,
	focusLine,
	onOpenPath,
}: {
	path: string;
	root?: string | null;
	toolbar?: ReactNode;
	/** 从「改动过的文件」那些 chip 点开时传 `"diff"`：用户要的是「改了什么」，别让他先看完整文件再自己切页顶 */
	initialMode?: "diff" | null;
	/**
	 * 跳到第几行（1-based）：全文搜索的结果点进来时给。
	 * 打开 / 换文件时滚到那一行并短暂亮一下 —— 否则「搜到了但打开后还要自己找」等于没用。
	 */
	focusLine?: number;
	/**
	 * 路径对不上唯一文件、服务端给了候选时：把用户点的那一个打开。
	 * 不传就只显示候选清单（模板预览那种没有打开能力的场景）。
	 */
	onOpenPath?: (path: string) => void;
}) {
	const t = useT();
	const [state, setState] = useState<{
		text: string;
		bytes: number;
		truncated: boolean;
		binary: boolean;
		error?: string;
		/** 服务端给出的候选（相对工作区）：路径只写了个文件名、又匹配到好几个文件时才有 */
		candidates?: string[];
		/** 不是按原路径打开的（按文件名/后缀找回的）：实际打开的是哪个文件 */
		notedPath?: string;
	} | null>(null);
	// md 默认看预览，可切到源码；其它文件只有源码
	const isMarkdown = /\.(md|markdown)$/i.test(path);
	/**
	 * html：**默认渲染成页面**（报告类产物都是单文件 html，看源码没意义）。
	 * 走 /api/files/raw + iframe：sandbox 不给 allow-same-origin —— 报告里的脚本能跑，
	 * 但拿不到工作台的 cookie / localStorage / 父窗口。
	 */
	const isHtml = /\.(html?|xhtml)$/i.test(path);
	const isJson = /\.json$/i.test(path);
	// 图片走 /api/files/raw 直接显示（原来一律当"二进制不能预览"，图片也没法看）
	const isImage = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path);
	const query = `path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ""}`;
	const imageSrc = isImage ? `/api/files/raw?${query}` : null;
	// 视频 / 音频：走流式 + Range 的 /api/files/media（能拖动进度条）
	const isVideo = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(path);
	const isAudio = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(path);
	const mediaSrc = isVideo || isAudio ? `/api/files/media?${query}` : null;
	/** 视图：正文预览 / 正文源码 / **改动**（git diff） */
	const [mode, setMode] = useState<"preview" | "source" | "diff">(
		initialMode === "diff" ? "diff" : isMarkdown || isHtml ? "preview" : "source",
	);
	/**
	 * 当前视图 / 怎么切。
	 *
	 * 以前还有一个 `autoDiffMode` ref：区分「外层（改动过的文件 chip）要求直看改动」和「用户自己点的」——
	 * 因为按钮一直都在，自己点了没改动就只能给他一句「没有改动」。现在页顶那颗按钮**只在真有改动时**才画
	 * （见下面的 changed），点不到「改了但没改动」这种组合，这层区分就没用了。
	 */
	const pickMode = (next: "preview" | "source" | "diff") => setMode(next);
	/** 这个文件相对 HEAD 的改动（null = 还没查回来 / 不适用） */
	const [diff, setDiff] = useState<FileDiffPayload | null>(null);
	/** 折叠起来的块（按起始行记）：代码 / JSON 都靠它收起一大段 */
	const [folded, setFolded] = useState<Set<number>>(new Set());
	/** 自动换行：面板窄，长行横着滚就看不见后半行（默认开，偏好记在本机） */
	const [wrap, setWrap] = useStoredBool(WRAP_KEY, true);
	/** 一档字号：+2px（跟终端里那个步长一致；面板缩放那种 10% 的档位对「字号」太粗） */
	const FONT_STEP = 2;
	/**
	 * 代码字号（⌘/Ctrl + `+` / `-`，`0` 复位）：默认 15，和原来 CSS 里那个值一致。
	 * 用**字号**而不是 `zoom`：代码是等宽逐行的，改字号会让换行、行号列宽、折叠三角自动重排，
	 * 选区的行号也仍然对得上；偏好记在本机（设置里也能改同一个 key）。
	 */
	const [fontPx, setFontPx] = useStoredNumber(
		PREVIEW_FONT_KEY,
		PREVIEW_FONT_DEFAULT,
		PREVIEW_FONT_MIN,
		PREVIEW_FONT_MAX,
	);
	const fontPxRef = useRef(fontPx);
	fontPxRef.current = fontPx;
	/** 行选区（普通点 / Shift 连选 / Ctrl 加选，见 use-line-selection.ts） */
	const sel = useLineSelection(path);
	/** 正在「闪一下」的那一行：从全文搜索跳过来时高亮 1.4s，之后撤掉（免得一直亮着像被选中） */
	const [flashLine, setFlashLine] = useState<number | null>(null);
	/** 正文那个滚动容器（<pre>）：跳行要靠它算偏移，不能用 scrollIntoView（会连带滚面板） */
	const codeRef = useRef<HTMLPreElement | null>(null);
	/** 右键菜单：点在哪一行、鼠标拖选覆盖了哪几行 */
	const [menu, setMenu] = useState<FileLineMenuState | null>(null);
	/**
	 * 查找（Cmd/Ctrl+F 或右键「查找」）：**只在源码视图**有意义 —— 预览 / 改动那两屏没有行结构。
	 * `findIndex` 是「第几处命中」，跨行连续计数（滚到哪算哪）。
	 */
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findIndex, setFindIndex] = useState(0);
	/** 鼠标在这一块里吗：Cmd+F 只在「鼠标在代码这边」或「焦点在这块里」时接管（别抢浏览器的查找） */
	const viewerRef = useRef<HTMLDivElement | null>(null);
	const [pointerInside, setPointerInside] = useState(false);

	// 换文件（或外层要求直看改动）→ 回到这个文件的默认视图。
	// 判断只有一个来源（`isMarkdown || isHtml`）：以前初始值与这个 effect 各写一份，
	// 漏一处就会出现「初始化算出 preview → 挂载后立刻改成 source」这种事。
	useEffect(() => {
		setMode(initialMode === "diff" ? "diff" : isMarkdown || isHtml ? "preview" : "source");
	}, [path, initialMode, isMarkdown, isHtml]);

	/**
	 * 查一次「相对上次提交改了什么」。
	 * 不能等用户点「改动」才查：页顶要不要摆这个开关，就取决于查回来的 added/removed。
	 * 图片/媒体不查（没意义，还会白起一个 git 进程）。
	 */
	useEffect(() => {
		if (mediaSrc || imageSrc) {
			setDiff(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			const response = await fetch(`/api/files/diff?${query}`);
			if (cancelled) return;
			if (!response.ok) {
				setDiff(null);
				return;
			}
			setDiff((await response.json()) as FileDiffPayload);
		})();
		return () => {
			cancelled = true;
		};
	}, [query, mediaSrc, imageSrc]);

	useEffect(() => {
		let cancelled = false;
		sel.clear(); // 换文件：旧行号对不上新文件
		if (mediaSrc) {
			// 媒体不用读文本：直接交给 <video> / <audio> 流式播
			setState({ text: "", bytes: 0, truncated: false, binary: false });
			return () => {
				cancelled = true;
			};
		}
		void (async () => {
			const response = await fetch(
				`/api/files/read?path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ""}`,
			);
			const body = (await response.json()) as {
				text?: string;
				bytes?: number;
				truncated?: boolean;
				binary?: boolean;
				/** 真正解析到的相对路径（服务端按文件名/后缀找回时，和用户点的不一样） */
				path?: string;
				matchedBy?: "suffix";
				error?: { message?: string; candidates?: string[] };
			};
			if (cancelled) return;
			if (!response.ok) {
				setState({
					text: "",
					bytes: 0,
					truncated: false,
					binary: false,
					error: body.error?.message ?? `HTTP ${response.status}`,
					...(body.error?.candidates ? { candidates: body.error.candidates } : {}),
				});
				return;
			}
			setState({
				text: body.text ?? "",
				bytes: body.bytes ?? 0,
				truncated: body.truncated === true,
				binary: body.binary === true,
				...(body.matchedBy === "suffix" && body.path ? { notedPath: body.path } : {}),
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [path, root, imageSrc, mediaSrc]);

	const folds = useMemo<FoldRange[]>(
		() => (state && !state.binary && !state.error ? computeFolds(state.text) : []),
		[state],
	);
	/**
	 * 默认折叠：**json 只展开第一层**，其余文件全展开。
	 *
	 * 用户 2026-10-30：「把『一次只展开一层』放到源码这边，源码里默认只展开第一层」——
	 * 活动配置那种几十上百个键的 JSON，进来全展开看着就蒙；先看第一层（哪些大块），
	 * 想看哪块就双击哪行展开（见 FileLines 的双击）。
	 *
	 * 依赖里带 `folds`：正文还没读回来时 folds 是空的，读完再算一次默认值；
	 * 换文件时也靠它重置（行号对不上旧的折叠会乱）。
	 */
	useEffect(() => {
		setFolded(new Set(isJson ? firstLevelFolds(folds) : []));
	}, [path, isJson, folds]);

	const language = languageOf(path);
	/** 查回来了吗 / 真有改动 */
	const diffReady = diff !== null;
	const changed = diffReady && diff.isRepo && diff.error === undefined && diff.diff !== "";
	/**
	 * 没改动（不是仓库 / 没改 / 查失败 / 刚被还原）就别把人留在 diff 视图里 ——
	 * 页顶那颗按钮已经不见了，再停在这一页就变成「没有出口的一页」。
	 * 从 chip 点进来的也一样：用户要的是「看看这个文件改了什么」，把文件摄开比一句「没有改动」有用。
	 */
	useEffect(() => {
		if (mode !== "diff" || !diffReady || changed) return;
		setMode(isMarkdown || isHtml ? "preview" : "source");
	}, [mode, diffReady, changed, isMarkdown, isHtml]);
	// ⚠️ 必须 memo：`split` 每次渲染都给新数组，而它是 useProgressiveHighlight 的依赖 ——
	// 直接内联会让「高亮 → setState → 重渲染 → 新数组 → 再高亮」无限循环（CPU 直接飙满）。
	// `\r?\n`：Windows 换行的文件每行带 `\r`，不剥掉会让复制出去的文本与逐行高亮都带 CR
	const lines = useMemo(
		() => (state && !state.binary && !state.error ? state.text.split(/\r?\n/) : EMPTY_LINES),
		[state],
	);
	/**
	 * 右键菜单要动的「这一块」：右键那行所在的**最内层**块（见 `blockAt`）。
	 * 不在任何块里的行（比如 JSON 最后一个 `}`）就是 null —— 菜单里不摆折叠那一项。
	 */
	const menuBlock = menu ? blockAt(folds, menu.line - 1) : null;
	/**
	 * 右键那块块的**原文**（0-based 行切片，直接给剪贴板）：
	 * 收起的块里那几十行在 DOM 里根本没渲染（`FileLines` 直接跳过），所以只能从 `lines` 取。
	 */
	const menuBlockText = menuBlock ? lines.slice(menuBlock.start, menuBlock.end + 1).join("\n") : "";

	/** 所有命中（大小写不敏感，原始文本上算：行号与偏移才对得上高亮那一层） */
	const findHits = useMemo(
		() => (findOpen && mode === "source" ? findInLines(lines, findQuery) : []),
		[findOpen, mode, lines, findQuery],
	);
	const findHit = findHits.length === 0 ? null : findHits[Math.min(findIndex, findHits.length - 1)];
	/** 当前命中是它那一行里的第几处（`markMatches` 用它决定哪一处高亮得更实） */
	const findOccurrence = useMemo(() => {
		if (!findHit) return 0;
		let occurrence = 0;
		for (const hit of findHits) {
			if (hit.line !== findHit.line) continue;
			if (hit.offset === findHit.offset) return occurrence;
			occurrence += 1;
		}
		return 0;
	}, [findHits, findHit]);
	/** 有命中的行号集合：只有这些行才需要跑一遍 markMatches（大文件不能每行都跑） */
	const findHitLines = useMemo(() => new Set(findHits.map((hit) => hit.line)), [findHits]);
	/**
	 * 跳到 `focusLine`：等这一屏的内容真的画出来（`lines` 有值、还是源码视图）再滚 ——
	 * 刚挂载时 <pre> 里一行都没有，那会儿滚是滚不动的。
	 */
	useEffect(() => {
		if (!focusLine || mode !== "source" || lines.length === 0) return;
		const pre = codeRef.current;
		const row = pre?.querySelector<HTMLElement>(`[data-line="${focusLine - 1}"]`);
		if (!pre || !row) return;
		// 自己算偏移：scrollIntoView 会把滚动传给所有祖先，面板 / 页面会跟着动一下
		const box = pre.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		pre.scrollTop += rect.top - box.top - pre.clientHeight / 2 + rect.height / 2;
		setFlashLine(focusLine);
		const timer = setTimeout(() => setFlashLine(null), 1400);
		return () => clearTimeout(timer);
	}, [focusLine, mode, lines.length, path]);

	/**
	 * 跳到一个命中：先把包着它的折叠块展开（不然滚过去也看不见那一行），再把那一行滚到视野中间。
	 * 两个 effect：前一个改折叠状态，后一个等折叠生效（`folded` 变了）再滚。
	 */
	useEffect(() => {
		if (!findHit || mode !== "source") return;
		setFolded((current) => {
			const next = expandFoldsContaining(folds, current, findHit.line);
			return next.size === current.size ? current : next;
		});
	}, [findHit, folds, mode]);
	useEffect(() => {
		if (!findHit || mode !== "source") return;
		const pre = codeRef.current;
		const row = pre?.querySelector<HTMLElement>(`[data-line="${findHit.line}"]`);
		if (!pre || !row) return;
		const box = pre.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		pre.scrollTop += rect.top - box.top - pre.clientHeight / 2 + rect.height / 2;
	}, [findHit, folded, mode]);

	/**
	 * Cmd/Ctrl+F：接管浏览器查找，改成找「这份文件」。
	 *
	 * 只在两种情况下接管（用户 2026-10-30：「鼠标在右代码中时」）：
	 *   - 焦点在这块里（点过代码 / 正在查找框里按）；
	 *   - 或者鼠标正悬在这块上、而焦点没落在别处的输入框里（在输入框里打字时别抢）。
	 * 其它情况照旧交给浏览器的页内查找 —— 那不是这个功能该管的地方。
	 */
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const viewer = viewerRef.current;
			if (!viewer) return;
			const focusInside = viewer.contains(document.activeElement);
			if (!focusInside && !pointerInside) return;
			const active = document.activeElement;
			// 焦点在别处的输入框里（例如左边正在写消息）就别抢
			if (!focusInside && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return;

			/* ⌘/Ctrl + `+` / `-` / `0`：只改这一屏的字号（用户 2026-10-30：
			   「跟终端里一样，Ctrl 加 + 或 - 时，这个里的文字会变大变小」）。
			   **必须** preventDefault，否则浏览器会把 Ctrl+`=` 当成整页缩放。 */
			const intent = zoomIntent(event);
			if (intent) {
				if (mode !== "source") return;
				event.preventDefault();
				event.stopPropagation();
				if (intent === "reset") setFontPx(PREVIEW_FONT_DEFAULT);
				else setFontPx(fontPxRef.current + (intent === "in" ? FONT_STEP : -FONT_STEP));
				return;
			}

			if (event.key !== "f" && event.key !== "F") return;
			if (!event.metaKey && !event.ctrlKey) return;
			// 这一屏没有行结构（md 预览 / 改动 / 图片）就别吃这个快捷键
			if (mode !== "source") return;
			event.preventDefault();
			setFindOpen(true);
		};
		// 捕获阶段：抢在浏览器缩放 / 页面其它快捷键之前
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [pointerInside, mode, setFontPx]);

	// 换文件：查找框收起来（查的是上一份文件的关键词，留着只会误导）
	useEffect(() => {
		setFindOpen(false);
		setFindQuery("");
		setFindIndex(0);
	}, [path]);

	/** 追加引用到输入框：**接在已有草稿后面**（不清空用户已经打的字） */
	const appendReference = (reference: string) => {
		const current = getAppState().draft;
		const glue = current === "" || current.endsWith(" ") ? "" : " ";
		setDraft(`${current}${glue}${reference} `);
	};

	/**
	 * 把「这一块代码」整段加进草稿：收起时里面那些行根本选不到，所以从 `lines` 里切原文，
	 * 拼成 `@path:3-7` + 代码块（和右键「复制这一块代码」是同一份内容）。
	 * 草稿里已经写了东西就空一行再接，避免粘在上一句末尾。
	 */
	const appendBlockCode = () => {
		if (!menuBlock) return;
		const code = lines.slice(menuBlock.start, menuBlock.end + 1).join("\n");
		if (code.trim() === "") return;
		const snippet = codeSnippet(path, { start: menuBlock.start + 1, end: menuBlock.end + 1 }, code, language);
		const current = getAppState().draft;
		const glue = current === "" || current.endsWith("\n") ? "" : "\n";
		// 代码块后面换行而不是补空格的：光标落在新一行，接着写「这段有什么问题」最顺手
		setDraft(`${current}${glue}${snippet}\n`);
	};

	// 逐行高亮：**分批上色**（大文件也能有颜色，不再整篇黑白）
	// 多行结构（块注释中间的几行）颜色可能不准，但绝不会破坏 HTML/结构
	const highlightLine = useCallback((line: string, lang: string) => {
		try {
			return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
		} catch {
			return "";
		}
	}, []);
	const {
		html: highlighted,
		done: highlightDone,
		total: highlightTotal,
	} = useProgressiveHighlight(lines, language !== "" && hljs.getLanguage(language) ? language : "", highlightLine);

	const addToConversation = () => {
		appendReference(referenceForSelection(path, sel.selection));
		sel.clear();
	};

	return (
		<div
			className="file-viewer"
			ref={viewerRef}
			/* 鼠标在这一块里 = 用户「正在看这份代码」，这时 Cmd/Ctrl+F 才是找它 */
			onPointerEnter={() => setPointerInside(true)}
			onPointerLeave={() => setPointerInside(false)}
		>
			<div className="file-preview-head">
				{/*
				 * 文件名**不再重复显示**：标签上已经有它了（用户提的）。
				 * 这一行只留「多大 · 什么语言」，以及右边那排「怎么显示」的按钮。
				 */}
				<span className="file-preview-meta">
					{mediaSrc
						? isVideo
							? t("视频", "Video")
							: t("音频", "Audio")
						: state
							? t(`${state.bytes} 字节`, `${state.bytes} bytes`)
							: t("读取中…", "Loading…")}
					{state?.truncated ? t("（已截断）", "(truncated)") : ""}
					{language ? ` · ${language}` : ""}
				</span>
				<span className="topbar-spacer" />
				{/* 源码 / 改动（Diff）切换：**一直都在**，点一下就能看对比（有没有改动由视图自己说） */}
				{mediaSrc || imageSrc ? null : (
					<span className="preview-mode">
						<button
							type="button"
							className={mode === "source" ? "preview-mode-on" : ""}
							onClick={() => pickMode("source")}
						>
							{t("源码", "Source")}
						</button>
						{isMarkdown || isHtml ? (
							<button
								type="button"
								className={mode === "preview" ? "preview-mode-on" : ""}
								onClick={() => pickMode("preview")}
							>
								{isHtml ? t("页面", "Page") : t("预览", "Preview")}
							</button>
						) : null}
						{/* 「改动」**只在真有改动时**才画：没改动的文件上摆一颗只会点出一句「没有改动」，
						 * 白占一排宽度（用户明确：没改动就别显示这两个字）。
						 * 代价是刚打开文件的那一下会等 diff 查回来才出现（本地 git，一瞬）；
						 * 为了不闪，宁可不先画一颗再改口。 */}
						{changed ? (
							<button
								type="button"
								className={mode === "diff" ? "preview-mode-on" : ""}
								onClick={() => pickMode("diff")}
								title={t("相对上次提交（HEAD）改了什么", "What changed since the last commit (HEAD)")}
							>
								{t("改动", "Diff")}
								{diff ? (
									<span className="preview-mode-diff">
										<span className="preview-mode-plus">+{diff.added}</span>
										<span className="preview-mode-minus">−{diff.removed}</span>
									</span>
								) : null}
							</button>
						) : null}
					</span>
				)}
				{/*
				 * 自动换行开关 + 右边那颗「文件列表」开关（`toolbar`）**挨着摆在最右边**，
				 * 一组「这一屏怎么显示」的小按钮；中间那组「源码 / 预览 / 改动」是切视图的正文入口。
				 * 顺序是用户定的：先切视图，再摆显示开关，别把开关夹在标题和视图切换中间。
				 */}
				{/* 自动换行只对源码那屏有意义 */}
				{mediaSrc || imageSrc ? null : (
					<button
						type="button"
						className={`btn btn-tiny preview-wrap${wrap ? " preview-wrap-on" : ""}`}
						onClick={() => setWrap(!wrap)}
						title={
							wrap
								? t("自动换行：开（长行折行显示）", "Word wrap: on (long lines wrap)")
								: t("自动换行：关（长行横向滚动）", "Word wrap: off (long lines scroll sideways)")
						}
						aria-pressed={wrap}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path
								d="M2 3.6h12M2 7.2h8.6a2.4 2.4 0 1 1 0 4.8H8.4"
								stroke="currentColor"
								strokeWidth="1.4"
								fill="none"
								strokeLinecap="round"
							/>
							<path
								d="m9.6 10.4-1.6 1.6 1.6 1.6"
								stroke="currentColor"
								strokeWidth="1.4"
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
								transform="translate(0,-1.2)"
							/>
							<path d="M2 10.8h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
						</svg>
					</button>
				)}
				{toolbar}
			</div>
			{state?.notedPath ? (
				<div className="file-preview-note">
					{t(`按文件名匹配到 ${state.notedPath}`, `Matched by file name: ${state.notedPath}`)}
				</div>
			) : null}
			{state?.error ? (
				<div className="file-preview-error">
					<span>{state.error}</span>
					{state.candidates && state.candidates.length > 0 ? (
						<ul className="file-preview-candidates">
							{state.candidates.map((candidate) => (
								<li key={candidate}>
									<button type="button" title={candidate} onClick={() => onOpenPath?.(candidate)}>
										{candidate}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			{imageSrc ? (
				<div className="file-image-wrap">
					<img className="file-image" src={imageSrc} alt={path} />
				</div>
			) : null}
			{isVideo && mediaSrc ? (
				<div className="file-media">
					{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
					<video className="file-video" src={mediaSrc} controls playsInline preload="metadata" />
				</div>
			) : null}
			{isAudio && mediaSrc ? (
				<div className="file-media">
					<audio className="file-audio" src={mediaSrc} controls preload="metadata" />
				</div>
			) : null}
			{state?.binary && imageSrc === null && mediaSrc === null ? (
				<div className="file-preview-error">
					{t("这是二进制文件，不能预览", "This is a binary file and cannot be previewed")}
				</div>
			) : null}
			{state && !state.binary && !state.error && isMarkdown && mode === "preview" ? (
				<div className="file-preview-md">
					<Markdown text={state.text} />
				</div>
			) : null}
			{/* html：直接把页面渲出来（报告类产物看的就是这个）。
			    sandbox 不给 allow-same-origin：脚本能跑，但碰不到工作台的存储与父窗口。 */}
			{isHtml && mode === "preview" ? (
				<div className="file-html-wrap">
					<iframe
						className="file-html-frame"
						title={path}
						src={`/api/files/raw?${query}`}
						sandbox="allow-scripts allow-popups allow-forms allow-modals"
						referrerPolicy="no-referrer"
					/>
				</div>
			) : null}
			{/* 改动视图：与「正文预览」并列的两块，用户切着看（先看改了什么，再回到全文看上下文） */}
			{mode === "diff" && diff ? <FileDiff payload={diff} /> : null}
			{/* 还在查改动：给句话，别让面板一片空白 */}
			{mode === "diff" && diff === null ? (
				<div className="file-diff-empty">{t("正在读取改动…", "Reading the diff…")}</div>
			) : null}
			{state && !state.binary && !state.error && mediaSrc === null && mode === "source" ? (
				<pre
					ref={codeRef}
					className={`file-preview-body mono${wrap ? " file-preview-body-wrap" : ""}`}
					/*
					 * 行号列宽按「最大行号的位数」算（4 位数就给 4ch）：列宽固定成 3.2em 时，
					 * 两位数的行号会离左边的折叠三角很远 —— 看着像两块东西。
					 */
					style={
						{
							"--ln-w": `${Math.max(2, String(lines.length).length)}ch`,
							fontSize: `${fontPx}px`,
						} as React.CSSProperties
					}
					onContextMenu={(event) => {
						// 只在这一行上右键才弹菜单；点在空白处交回浏览器默认菜单
						const row = (event.target as HTMLElement).closest("[data-line]");
						if (!row) return;
						const line = Number(row.getAttribute("data-line")) + 1;
						if (!Number.isFinite(line)) return;
						event.preventDefault();
						const dragged = draggedSelection(event.currentTarget);
						setMenu({
							point: { x: event.clientX, y: event.clientY },
							line,
							dragRange: dragged.range,
							dragText: dragged.text,
						});
					}}
				>
					<FileLines
						lines={lines}
						highlighted={highlighted}
						folds={folds}
						folded={folded}
						isSelected={(line) => sel.has(line)}
						flashLine={flashLine}
						onToggleFold={(index) => setFolded((current) => toggleFolded(folds, current, index))}
						onPick={(index, modifiers) => sel.click(index, modifiers)}
						find={
							findOpen && findQuery !== ""
								? { needle: findQuery, line: findHit?.line ?? -1, occurrence: findOccurrence, lines: findHitLines }
								: null
						}
					/>
				</pre>
			) : null}
			{findOpen && mode === "source" && mediaSrc === null ? (
				<FileFindBar
					query={findQuery}
					onQuery={(value) => {
						setFindQuery(value);
						setFindIndex(0);
					}}
					total={findHits.length}
					index={findHits.length === 0 ? 0 : Math.min(findIndex, findHits.length - 1)}
					/* 没有命中时不动（别让 0 做模运算算出 NaN） */
					onPrev={() =>
						setFindIndex((current) => (findHits.length === 0 ? 0 : (current - 1 + findHits.length) % findHits.length))
					}
					onNext={() => setFindIndex((current) => (findHits.length === 0 ? 0 : (current + 1) % findHits.length))}
					onClose={() => {
						setFindOpen(false);
						setFindQuery("");
					}}
				/>
			) : null}
			{!highlightDone && highlightTotal > 0 ? (
				<div className="file-preview-hint">
					文件较大（{highlightTotal.toLocaleString()} 行），正在分批上色…（可以边看边滚，不影响滚动）
				</div>
			) : null}
			{menu ? (
				<FileLineMenu
					state={menu}
					appSelection={sel.selection}
					onAddSelection={addToConversation}
					onAddRange={(range) => appendReference(referenceFor(path, range))}
					onClearSelection={sel.clear}
					/* 折叠那项的作用范围 = 右键那行所在的块（含里面嵌套的，见 file-preview.ts 的 blockAt）；
					   按它的折叠状态只摆一个动作（收起 / 展开这一块 / 展开里面全部） */
					block={menuBlock}
					blockState={menuBlock ? blockFoldState(folds, folded, menuBlock) : null}
					onExpandBlock={(block) => setFolded((current) => expandBlock(folds, current, block))}
					onCollapseBlock={(block) => setFolded((current) => collapseBlock(folds, current, block))}
					blockText={menuBlockText}
					blockFolded={menuBlock !== null && folded.has(menuBlock.start)}
					onAddBlock={appendBlockCode}
					onFind={(preset) => {
						setFindQuery(preset);
						setFindIndex(0);
						setFindOpen(true);
					}}
					onClose={() => setMenu(null)}
				/>
			) : null}
		</div>
	);
}
