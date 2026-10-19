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
import { useEffect, useMemo, useState } from "react";
import {
	describeRange,
	languageOf,
	MAX_HIGHLIGHT_LINES,
	normalizeRange,
	referenceFor,
	type LineRange,
} from "../file-preview.ts";
import { setDraft } from "../store.ts";

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
export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
	const [state, setState] = useState<{
		text: string;
		bytes: number;
		truncated: boolean;
		binary: boolean;
		error?: string;
	} | null>(null);
	const [anchor, setAnchor] = useState<number | null>(null);
	const [focus, setFocus] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		setAnchor(null);
		setFocus(null);
		void (async () => {
			const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
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
	}, [path]);

	const language = languageOf(path);
	const lines = state && !state.binary && !state.error ? state.text.split("\n") : [];
	const range: LineRange | null = anchor === null || focus === null ? null : normalizeRange(anchor, focus);

	// 逐行高亮（多行结构如块注释中间的几行颜色可能不准，但绝不会破坏 HTML/结构）
	const highlighted = useMemo(() => {
		if (lines.length === 0) return [] as string[];
		if (lines.length > MAX_HIGHLIGHT_LINES || language === "" || !hljs.getLanguage(language)) return [] as string[];
		return lines.map((line) => {
			try {
				return hljs.highlight(line, { language, ignoreIllegals: true }).value;
			} catch {
				return "";
			}
		});
	}, [lines, language]);

	const addToConversation = () => {
		setDraft(`${referenceFor(path, range)} `);
		onClose();
	};

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="文件预览">
			<div className="modal file-preview">
				<div className="file-preview-head">
					<span className="file-preview-path mono">{path}</span>
					<span className="file-preview-meta">
						{state ? `${state.bytes} 字节` : "读取中…"}
						{state?.truncated ? "（已截断）" : ""}
						{language ? ` · ${language}` : ""}
					</span>
					<span className="topbar-spacer" />
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
					<button type="button" className="btn btn-tiny" onClick={onClose}>
						关闭
					</button>
				</div>
				{state?.error ? <div className="file-preview-error">{state.error}</div> : null}
				{state?.binary ? <div className="file-preview-error">这是二进制文件，不能预览</div> : null}
				{state && !state.binary && !state.error ? (
					<pre className="file-preview-body mono">
						{lines.map((line, index) => {
							const selected = range !== null && index + 1 >= range.start && index + 1 <= range.end;
							const html = highlighted[index];
							return (
								<div className={`file-preview-line${selected ? " file-preview-line-on" : ""}`} key={index}>
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
								</div>
							);
						})}
					</pre>
				) : null}
				{lines.length > MAX_HIGHLIGHT_LINES && language !== "" ? (
					<div className="file-preview-hint">文件较大（{lines.length} 行），已关闭语法高亮以保证流畅</div>
				) : null}
			</div>
		</div>
	);
}
