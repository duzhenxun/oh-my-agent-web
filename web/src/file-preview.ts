/**
 * 文件预览的纯函数（M4 增强）：语言判定、行范围、对话引用语法。
 *
 * 「选中多行添加到对话」刻意采用**路径 + 行号引用**（`@path:10-20`），而不是注入文件内容：
 * 这正是 ADR-0002 的原则（附件只给路径引用），模型自己有 read 工具可以按行号去读。
 */
import { basename } from "./path-utils.ts";

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	css: "css",
	scss: "scss",
	html: "xml",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	markdown: "markdown",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	sql: "sql",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	dockerfile: "dockerfile",
};

/** 纯函数：按扩展名猜语言（猜不出返回空串 = 不做高亮） */
export function languageOf(path: string): string {
	// 同时认 `/` 与 `\`：agent 给的是原生路径，Windows 上是 `C:\a\Dockerfile`
	const name = basename(path);
	const lower = name.toLowerCase();
	if (lower === "dockerfile") return "dockerfile";
	if (lower === "makefile") return "makefile";
	const extension = lower.includes(".") ? (lower.split(".").pop() ?? "") : "";
	return EXTENSION_LANGUAGE[extension] ?? "";
}

export type LineRange = { start: number; end: number };

/** 纯函数：把锚点与焦点整理成 1-based 的行范围（自动交换顺序） */
export function normalizeRange(anchor: number, focus: number): LineRange {
	const start = Math.min(anchor, focus) + 1;
	const end = Math.max(anchor, focus) + 1;
	return { start, end };
}

/** 纯函数：写进对话的引用（单行不带区间，多行带 a-b） */
export function referenceFor(path: string, range: LineRange | null): string {
	if (!range) return `@${path}`;
	return range.start === range.end ? `@${path}:${range.start}` : `@${path}:${range.start}-${range.end}`;
}

/* ---------------- 多段选区（Ctrl 点出来的那些不连续行） ---------------- */

/** 一整套选区：按 start 排序、相邻/重叠已合并（永远没有重复行） */
export type LineSelection = LineRange[];

/** 纯函数：排序 + 合并相邻与重叠（`3-5` + `6-8` + `4` → `3-8`） */
export function mergeRanges(ranges: readonly LineRange[]): LineSelection {
	const sorted = ranges
		.filter((range) => range.end >= range.start)
		.map((range) => ({ start: range.start, end: range.end }))
		.sort((a, b) => a.start - b.start);
	const merged: LineSelection = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

/** 纯函数：选区内一共多少行 */
export function selectionLines(selection: LineSelection): number {
	return selection.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
}

/**
 * 纯函数：多段选区 → 写进对话的引用串。
 *
 * 每一段一个 `@path:a-b`，用空格隔开（模型本来就把一个 `@path:10-20` 当路径+行号读，
 * 多段就多写几个；不把不连续的行合成一大段 —— 那会把没选的行也算进去）。
 */
export function referenceForSelection(path: string, selection: LineSelection): string {
	if (selection.length === 0) return `@${path}`;
	return selection.map((range) => referenceFor(path, range)).join(" ");
}

/** 可折叠区间（行号 0-based，闭区间）：`{ … }` / `[ … ]` 这种块 */
export type FoldRange = { start: number; end: number };

/**
 * 纯函数：找出可以折叠的「块」。
 *
 * 做法是扫一遍字符（跳过字符串与注释，避免把 `"{"` 里的括号算进去）：
 * 遇到 `{` / `[` 记下起始行，遇到配对的 `}` / `]` 且跨了行，就形成一个可折叠区间。
 * 只认跨行的块（同一行闭合的 `{}` 折叠没意义）。
 */
export function computeFolds(text: string): FoldRange[] {
	const folds: FoldRange[] = [];
	const stack: number[] = [];
	let line = 0;
	let quote: string | null = null;
	let blockComment = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "\n") {
			line += 1;
			// 普通字符串不跨行（模板串 ` 允许换行）
			if (quote !== "`") quote = null;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && text[i + 1] === "/") {
				blockComment = false;
				i += 1;
			}
			continue;
		}
		if (quote) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			const newline = text.indexOf("\n", i);
			if (newline === -1) break;
			i = newline - 1; // 交给下一轮处理换行
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			blockComment = true;
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(line);
			continue;
		}
		if (ch === "}" || ch === "]") {
			const start = stack.pop();
			if (start !== undefined && line > start) folds.push({ start, end: line });
		}
	}
	return folds.sort((a, b) => a.start - b.start);
}
