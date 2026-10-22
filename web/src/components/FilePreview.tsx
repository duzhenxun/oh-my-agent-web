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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	computeFolds,
	describeRange,
	languageOf,
	normalizeRange,
	referenceFor,
	type FoldRange,
	type LineRange,
} from "../file-preview.ts";
import { useProgressiveHighlight } from "../progressive-highlight.ts";
import { setDraft } from "../store.ts";
import { Markdown } from "./Markdown.tsx";

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
 *   - **点行号选中、Shift+点行号选范围** → 「添加到对话」写进输入框的是 `@path:10-20` 这种**引用**，
 *     不注入文件内容（ADR-0002 的原则：只给路径引用，模型自己去 read 那几行）。
 */
/**
 * 文件内容视图（从原来的 FilePreview 弹窗里抽出来）：
 * 只管「读文件 + 显示 + 行选中 + 添加到对话」，不再管外壳（弹窗 or 右侧面板）。
 * `toolbar` 由外壳决定放什么按钮（关闭 / 全屏 / 标签…）。
 */
export function FileViewer({ path, root, toolbar }: { path: string; root?: string | null; toolbar?: ReactNode }) {
	const [state, setState] = useState<{
		text: string;
		bytes: number;
		truncated: boolean;
		binary: boolean;
		error?: string;
	} | null>(null);
	// md 默认看预览，可切到源码；其它文件只有源码
	const isMarkdown = /\.(md|markdown)$/i.test(path);
	// 图片走 /api/files/raw 直接显示（原来一律当"二进制不能预览"，图片也没法看）
	const isImage = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path);
	const query = `path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ""}`;
	const imageSrc = isImage ? `/api/files/raw?${query}` : null;
	// 视频 / 音频：走流式 + Range 的 /api/files/media（能拖动进度条）
	const isVideo = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(path);
	const isAudio = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(path);
	const mediaSrc = isVideo || isAudio ? `/api/files/media?${query}` : null;
	const [mode, setMode] = useState<"preview" | "source">(isMarkdown ? "preview" : "source");
	/** 折叠起来的块（按起始行记）：代码 / JSON 都靠它收起一大段 */
	const [folded, setFolded] = useState<Set<number>>(new Set());
	const [anchor, setAnchor] = useState<number | null>(null);
	const [focus, setFocus] = useState<number | null>(null);
	useEffect(() => {
		// 换文件就把折叠状态清掉（行号对不上旧的会乱）
		setFolded(new Set());
	}, [path]);

	useEffect(() => {
		let cancelled = false;
		setAnchor(null);
		setFocus(null);
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
				error?: { message?: string };
			};
			if (cancelled) return;
			if (!response.ok) {
				setState({
					text: "",
					bytes: 0,
					truncated: false,
					binary: false,
					error: body.error?.message ?? `HTTP ${response.status}`,
				});
				return;
			}
			setState({
				text: body.text ?? "",
				bytes: body.bytes ?? 0,
				truncated: body.truncated === true,
				binary: body.binary === true,
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
	/** 起始行 → 结束行 */
	const foldEnds = useMemo(() => new Map(folds.map((fold) => [fold.start, fold.end])), [folds]);

	const language = languageOf(path);
	// ⚠️ 必须 memo：`split` 每次渲染都给新数组，而它是 useProgressiveHighlight 的依赖 ——
	// 直接内联会让「高亮 → setState → 重渲染 → 新数组 → 再高亮」无限循环（CPU 直接飙满）。
	const lines = useMemo(() => (state && !state.binary && !state.error ? state.text.split("\n") : EMPTY_LINES), [state]);
	const range: LineRange | null = anchor === null || focus === null ? null : normalizeRange(anchor, focus);

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
		setDraft(`${referenceFor(path, range)} `);
		setAnchor(null);
		setFocus(null);
	};

	return (
		<div className="file-viewer">
			<div className="file-preview-head">
				<span className="file-preview-path mono" title={path}>
					{path.split("/").filter(Boolean).pop() ?? path}
				</span>
				<span className="file-preview-meta">
					{mediaSrc ? (isVideo ? "视频" : "音频") : state ? `${state.bytes} 字节` : "读取中…"}
					{state?.truncated ? "（已截断）" : ""}
					{language ? ` · ${language}` : ""}
				</span>
				<span className="topbar-spacer" />
				{isMarkdown ? (
					<span className="preview-mode">
						<button
							type="button"
							className={mode === "source" ? "preview-mode-on" : ""}
							onClick={() => setMode("source")}
						>
							源码
						</button>
						<button
							type="button"
							className={mode === "preview" ? "preview-mode-on" : ""}
							onClick={() => setMode("preview")}
						>
							预览
						</button>
					</span>
				) : null}
				<span className="file-preview-selection">{describeRange(range)}</span>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={addToConversation}
					title="把这段引用插到输入框（不注入内容）"
				>
					添加到对话
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => {
						setAnchor(null);
						setFocus(null);
					}}
					disabled={range === null}
				>
					清除
				</button>
				{toolbar}
			</div>
			{state?.error ? <div className="file-preview-error">{state.error}</div> : null}
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
				<div className="file-preview-error">这是二进制文件，不能预览</div>
			) : null}
			{state && !state.binary && !state.error && isMarkdown && mode === "preview" ? (
				<div className="file-preview-md">
					<Markdown text={state.text} />
				</div>
			) : null}
			{state && !state.binary && !state.error && mediaSrc === null && !(isMarkdown && mode === "preview") ? (
				<pre className="file-preview-body mono">
					{(() => {
						// 逐行渲染：遇到「折叠中的块」就跳过它内部的行（嵌套也按最大 end 跳过）
						let hideUntil = -1;
						return lines.map((line, index) => {
							if (index <= hideUntil) return null;
							const foldEnd = foldEnds.get(index);
							const canFold = foldEnd !== undefined && foldEnd > index;
							const isFolded = canFold && folded.has(index);
							if (isFolded) hideUntil = foldEnd;
							const selected = range !== null && index + 1 >= range.start && index + 1 <= range.end;
							const html = highlighted[index];
							return (
								<div
									className={`file-preview-line file-preview-line-clickable${selected ? " file-preview-line-on" : ""}`}
									key={index}
									title="点选中这一行（Shift+点选范围，双击直接加到对话）"
									onClick={() => {
										// 用户正在选文字时不抢选择（否则复制粘贴会失效）
										if (!window.getSelection()?.isCollapsed) return;
										setAnchor(index);
										setFocus(index);
									}}
									onDoubleClick={() => setDraft(`${referenceFor(path, { start: index + 1, end: index + 1 })} `)}
								>
									{canFold ? (
										<button
											type="button"
											className={`file-fold${isFolded ? " file-fold-collapsed" : ""}`}
											title={isFolded ? "展开这一段" : "折叠这一段"}
											onClick={(event) => {
												event.stopPropagation();
												setFolded((current) => {
													const next = new Set(current);
													if (next.has(index)) next.delete(index);
													else next.add(index);
													return next;
												});
											}}
										>
											{isFolded ? "▸" : "▾"}
										</button>
									) : (
										<span className="file-fold file-fold-empty" aria-hidden="true" />
									)}
									<button
										type="button"
										className="file-preview-no"
										title="点选这一行（Shift+点选范围）"
										onClick={(event) => {
											if (event.shiftKey && anchor !== null) {
												setFocus(index);
												return;
											}
											setAnchor(index);
											setFocus(index);
										}}
									>
										{index + 1}
									</button>
									{html !== undefined ? (
										<span className="file-preview-text" dangerouslySetInnerHTML={{ __html: html || " " }} />
									) : (
										<span className="file-preview-text">{line || " "}</span>
									)}
									{isFolded && foldEnd !== undefined ? (
										<span className="file-fold-summary">⋯ {foldEnd - index} 行已折叠</span>
									) : null}
								</div>
							);
						});
					})()}
				</pre>
			) : null}
			{!highlightDone && highlightTotal > 0 ? (
				<div className="file-preview-hint">
					文件较大（{highlightTotal.toLocaleString()} 行），正在分批上色…（可以边看边滚，不影响滚动）
				</div>
			) : null}
		</div>
	);
}
