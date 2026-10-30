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

/**
 * 纯函数：「只展开第一层」的默认折叠。
 *
 * `computeFolds` 的结果是按起始行排序的，第一项就是**最外层**那一块（整份文件的那对括号）；
 * 除了它，其余块（都是嵌在里面的）默认收起 —— 于是打开文件先看到的就是第一层。
 *
 * 只给 JSON 用（用户 2026-10-30 定的）：代码文件里把每个函数都默认折叠起来会很碍事。
 */
export function firstLevelFolds(folds: readonly FoldRange[]): number[] {
	const outer = folds[0];
	if (!outer) return [];
	return folds.filter((fold) => fold !== outer).map((fold) => fold.start);
}

/**
 * 纯函数：折叠 / 展开一块（用户：「双击收起，再双击再只展开第一层」）。
 *
 * - 已收起 → 展开，并把它**里面**那些块重新收起来：一次只多看见一层，
 *   不会因为上次展开过就一下迸出好几层；
 * - 已展开 → 只收起这一块（里面的状态不动，再展开时会被上一层重置）。
 *
 * 返回新 Set（React 依赖引用变化才会重渲染）。
 */
export function toggleFolded(folds: readonly FoldRange[], folded: ReadonlySet<number>, start: number): Set<number> {
	const next = new Set(folded);
	if (next.has(start)) {
		next.delete(start);
		const block = folds.find((fold) => fold.start === start);
		if (block) {
			for (const fold of folds) if (fold.start > block.start && fold.end <= block.end) next.add(fold.start);
		}
		return next;
	}
	next.add(start);
	return next;
}

/**
 * 纯函数：当前行所属的块（右键菜单「展开 / 收起这一块」的作用范围）。
 *
 * 行本身就是块起点时就用它；否则取**最里面**那一层包着它的块（跨度越小越里面）——
 * 右键点在一行普通字段上时，用户心里那个「这块」就是它所在的那层对象。
 * 返回 null：这一行不在任何块里（文件末尾 / 顶层散行）。
 */
export function blockAt(folds: readonly FoldRange[], line: number): FoldRange | null {
	let best: FoldRange | null = null;
	for (const fold of folds) {
		const inside = fold.start === line || (line > fold.start && line <= fold.end);
		if (!inside) continue;
		if (!best || fold.end - fold.start < best.end - best.start) best = fold;
	}
	return best;
}

/**
 * 这一块现在是「全收着 / 只开了一部分 / 全开着」——右键菜单据此**只显示一个能用的动作**。
 *
 * 用户 2026-10-30：「这两个一次只会出现一种情况吧」——
 * 摆两项出来总有一项是白点的，所以按状态给出唯一那个该做的：
 *   - `collapsed`：这块自己收着 → 只能「展开这一块」；
 *   - `partial`：这块开着、但里面还有收着的 → 只能「展开里面全部」；
 *   - `open`：里面也全开着 → 只能「收起这一块」。
 */
export type BlockFoldState = "collapsed" | "partial" | "open";

export function blockFoldState(
	folds: readonly FoldRange[],
	folded: ReadonlySet<number>,
	block: FoldRange,
): BlockFoldState {
	if (folded.has(block.start)) return "collapsed";
	const inside = folds.some((fold) => fold.start > block.start && fold.end <= block.end && folded.has(fold.start));
	return inside ? "partial" : "open";
}

/**
 * 纯函数：把这一块**连同里面嵌套的**全部展开（右键菜单那项）。
 *
 * 用「从折叠集合里删掉」而不是「重建」：块外已经折叠好的那些不动，用户之前的手势不被打乱。
 */
export function expandBlock(folds: readonly FoldRange[], folded: ReadonlySet<number>, block: FoldRange): Set<number> {
	const next = new Set(folded);
	for (const fold of folds) if (fold.start >= block.start && fold.end <= block.end) next.delete(fold.start);
	return next;
}

/**
 * 纯函数：把这一块**连同里面嵌套的**全部收起（右键菜单那项）。
 *
 * 自己也算在内：收完之后只剩这一行，想看再双击展开一层。
 */
export function collapseBlock(folds: readonly FoldRange[], folded: ReadonlySet<number>, block: FoldRange): Set<number> {
	const next = new Set(folded);
	for (const fold of folds) if (fold.start >= block.start && fold.end <= block.end) next.add(fold.start);
	return next;
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

/**
 * 纯函数：把「这一块代码」拼成可以贴进对话的一段（路径引用 + 代码块）。
 *
 * 用户 2026-10-30：「收起的代码添加到对话时也跟复制那样，得把收起来的所有代码都带上」——
 * 折叠起来的几十行在屏幕上选不到，只给一个 `@path:3-7` 的话，模型还得自己再去 read 一遍；
 * 这里直接把原文贴进去（和右键「复制这一块代码」拿到的内容一模一样）。
 *
 * 引用行仍写在前面：人一眼知道这段来自哪个文件的哪几行，定位比纯代码块快。
 * 代码里本身带 ``` 时用四个反引号，免得把围栏提前关掉。
 */
export function codeSnippet(path: string, range: LineRange, code: string, language: string): string {
	const fence = code.includes("```") ? "````" : "```";
	return `${referenceFor(path, range)}\n${fence}${language}\n${code}\n${fence}`;
}

/* ---------------- 查找（右下角代码里的 Cmd/Ctrl+F） ---------------- */

/** 一处命中：第几行（0-based）+ 行内偏移 */
type FindHit = { line: number; offset: number };

/**
 * 纯函数：在整个文件里找 `needle`（**大小写不敏感**，不重叠计数：`aa` 在 `aaa` 里算 1 处）。
 *
 * `max` 是保险丝：搜一个「e」也会命中上万处，而界面只需要「有没有 / 第几个 / 一共几个」。
 * 找的是**原始文本**（不是高亮后的 HTML）—— 偏移、行号才对得上 `lines`。
 */
export function findInLines(lines: readonly string[], needle: string, max = 5000): FindHit[] {
	const lower = needle.toLowerCase();
	if (lower === "") return [];
	const hits: FindHit[] = [];
	for (let line = 0; line < lines.length; line += 1) {
		const hay = (lines[line] ?? "").toLowerCase();
		let from = 0;
		for (;;) {
			const at = hay.indexOf(lower, from);
			if (at < 0) break;
			hits.push({ line, offset: at });
			if (hits.length >= max) return hits;
			from = at + lower.length;
		}
	}
	return hits;
}

/** HTML 转义（没轮到高亮的行也要能被标出来，所以要自己拼那一段） */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 纯函数：把一行**高亮过的 HTML** 里的命中包成 `<mark>`（当前那一处多一个 `-on` 类）。
 *
 * 不做「在 HTML 字符串里直接 replace」那种事 —— 那会把 `<span class="hljs-string">` 里的
 * 尖括号/引号一起替换掉，整行渲染就崩了。这里按标签切开，只在**文本节点**里标，
 * 并把 `&quot;` / `&amp;` 这类实体还原成字符再匹配（所以搜引号也能对上高亮里的实体）。
 *
 * 已知取舍：跨了两个高亮标签的命中（`"a` 一半在 key span、一半在标点里）标不出来，
 * 但行号/计数仍然准 —— 这种命中的实际价值很低，为它写一套 DOM 级高亮不值得。
 */
export function markMatches(html: string, needle: string, current: number | null): string {
	const lower = needle.toLowerCase();
	if (lower === "") return html;
	let occurrence = 0;
	return html
		.split(/(<[^>]*>)/)
		.map((token) => {
			if (token.startsWith("<")) return token;
			const chars = decodeEntities(token);
			const lowerChars = chars.map((item) => item.char.toLowerCase());
			// 极少数语言里的「一个字符小写成两个」（İ → i̇）：这一块就不标了，别把偏移搞乱
			if (lowerChars.some((char) => char.length !== 1)) return token;
			const hay = lowerChars.join("");
			if (!hay.includes(lower)) return token;
			let out = "";
			let from = 0;
			for (;;) {
				const at = hay.indexOf(lower, from);
				if (at < 0) break;
				const end = at + lower.length;
				out += rawSlice(chars, from, at);
				const hit = rawSlice(chars, at, end);
				const on = occurrence === current ? " file-find-hit-on" : "";
				out += `<mark class="file-find-hit${on}">${hit}</mark>`;
				occurrence += 1;
				from = end;
			}
			out += rawSlice(chars, from, chars.length);
			return out;
		})
		.join("");
}

/** 跳到某个折叠里的行时，先把包着它的那些块展开（否则滚过去也看不见那一行） */
export function expandFoldsContaining(
	folds: readonly FoldRange[],
	folded: ReadonlySet<number>,
	line: number,
): Set<number> {
	const next = new Set(folded);
	for (const fold of folds) if (fold.start < line && line <= fold.end) next.delete(fold.start);
	return next;
}

function rawSlice(chars: readonly { raw: string }[], start: number, end: number): string {
	let out = "";
	for (let index = start; index < end; index += 1) out += chars[index]?.raw ?? "";
	return out;
}

/** 一个 HTML 实体 → 字符（认不出来的返回 null） */
function entityChar(name: string): string | null {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	if (name.startsWith("#")) {
		const code =
			name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
		if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
		try {
			return String.fromCodePoint(code);
		} catch {
			return null;
		}
	}
	return named[name] ?? null;
}

/** 把一段文本节点拆成「字符 + 它在原文里的写法」：这样标 `<mark>` 时能原样拼回去 */
function decodeEntities(token: string): { char: string; raw: string }[] {
	const out: { char: string; raw: string }[] = [];
	for (let index = 0; index < token.length;) {
		const char = token[index] ?? "";
		if (char === "&") {
			const semi = token.indexOf(";", index + 1);
			if (semi > index && semi - index <= 12) {
				const decoded = entityChar(token.slice(index + 1, semi));
				if (decoded !== null && decoded.length === 1) {
					out.push({ char: decoded, raw: token.slice(index, semi + 1) });
					index = semi + 1;
					continue;
				}
			}
		}
		out.push({ char, raw: char });
		index += 1;
	}
	return out;
}
