/**
 * 文件预览的纯函数（M4 增强）：语言判定、行范围、对话引用语法。
 *
 * 「选中多行添加到对话」刻意采用**路径 + 行号引用**（`@path:10-20`），而不是注入文件内容：
 * 这正是 ADR-0002 的原则（附件只给路径引用），模型自己有 read 工具可以按行号去读。
 */

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
	const name = path.split("/").pop() ?? path;
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

/** 纯函数：给人看的选中描述 */
export function describeRange(range: LineRange | null): string {
	if (!range) return "未选中";
	return range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}–${range.end} 行`;
}

/** 高亮行数上限：再大就退化成纯文本（避免几千行一起跑词法分析） */
export const MAX_HIGHLIGHT_LINES = 800;
