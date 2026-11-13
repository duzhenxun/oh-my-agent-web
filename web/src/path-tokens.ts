import { trimUrlToken } from "./url-tokens.ts";

/**
 * 消息里的「文件路径」识别 + 点击打开。
 *
 * 为什么单独一个模块：报告类回复（agent 跑完自测/审查）经常直接贴一段路径清单，
 * 用户想点开看却只能自己去文件树里翻。这里给两条能力：
 *   1. `looksLikePath` / `pathTokens`：判断一段文字里哪些是文件路径（纯函数，好测）；
 *   2. `setPathOpener` / `openPathFromMessage`：Markdown 渲染层深在组件树里，
 *      用模块级回调把「点路径 → 在右侧面板预览」接线进来，避免层层传 prop。
 *
 * **网址不是路径**（用户 2026-11-10）：`https://host/a/index.html` 的后缀正好在白名单里，
 * 以前会被认成工作区文件 → 渲染成路径按钮 → 点了去右侧面板找一个不存在的文件。
 * 现在网址一律由 url-tokens 认走，这里只认真正的本地路径（`pathTokens` 会把网址原样带出去）。
 */

/** 处理一次「点了消息里的路径」（由 App 注入：打开右侧预览面板） */
type PathOpener = (path: string) => void;

let opener: PathOpener | null = null;

export function setPathOpener(next: PathOpener | null): void {
	opener = next;
}

/** 点开一条路径；没人接线时静默失败（纯文字渲染场景，例如模板预览） */
export function openPathFromMessage(path: string): void {
	opener?.(path);
}

/** 明显不是文件名的后缀（避免把 v1.2 这种版本号当路径） */
const FILE_EXTENSIONS = new Set([
	"md",
	"markdown",
	"txt",
	"json",
	"jsonl",
	"yml",
	"yaml",
	"toml",
	"ini",
	"log",
	"csv",
	"tsv",
	"html",
	"htm",
	"xml",
	"css",
	"scss",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"jsx",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"swift",
	"rb",
	"php",
	"sh",
	"bash",
	"zsh",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"zip",
]);

/** 这段文字是不是一个文件路径（用于行内代码：`docs/report.html`） */
export function looksLikePath(text: string): boolean {
	const value = text.trim();
	if (value === "" || value.length > 300) return false;
	// 网址在这层就否掉：交给 url-tokens 当链接渲染（新标签页打开），别去右侧面板找文件
	if (/^https?:\/\//i.test(value)) return false;
	if (/\s/.test(value)) return false; // 带空格的一律不认（命令、句子）
	const match = /^[^\s]+\.([A-Za-z0-9]{1,8})$/.exec(value);
	if (!match) return false;
	if (!FILE_EXTENSIONS.has(match[1]!.toLowerCase())) return false;
	// 至少要有个路径分隔符，或者本来就带扩展名的纯文件名（README.md）
	return true;
}

/**
 * 一行里的「网址 / 路径」token。网址那个分支必须排在前：
 * `https://host/a/index.html` 从 `https` 开始就被网址认走，不会被后面的路径规则切成一段“文件名”。
 */
const SCAN = /(https?:\/\/[^\s<>"'`|\\]+)|((?:~\/|\.{0,2}\/)?[\w@.\-/（）()\u4e00-\u9fff]+\.([A-Za-z0-9]{1,8})\b)/g;

export type LineToken = { text: string; path?: string; url?: string };

/**
 * 把一段文本切成「文本 / 路径 / 网址」片段（代码块里逐行调用）。
 * 路径只认白名单扩展名；网址交给 url-tokens 收干净（句尾标点不算地址）；其余原样返回成文本。
 */
export function pathTokens(line: string): LineToken[] {
	const parts: LineToken[] = [];
	let last = 0;
	for (const match of line.matchAll(SCAN)) {
		if (match[1] !== undefined) {
			// 网址：不是真网址（光秃秃的 `https://`）就当普通文字，接着扫后面的
			const url = trimUrlToken(match[1]);
			if (url === null) continue;
			const start = match.index ?? 0;
			if (start > last) parts.push({ text: line.slice(last, start) });
			parts.push({ text: url, url });
			// 句尾剥掉的标点留给下一段文字（下标只前进网址那一段，不能吞掉标点）
			last = start + url.length;
			continue;
		}
		const token = match[2]!;
		const ext = (match[3] ?? "").toLowerCase();
		if (!FILE_EXTENSIONS.has(ext)) continue;
		const start = match.index ?? 0;
		if (start > last) parts.push({ text: line.slice(last, start) });
		parts.push({ text: token, path: token });
		last = start + token.length;
	}
	if (last < line.length) parts.push({ text: line.slice(last) });
	return parts.length > 0 ? parts : [{ text: line }];
}

/**
 * 这段代码块像不像「路径 / 网址清单」：报告里的目录树、产物列表、一组环境地址。
 * 判据：≥2 行，且**一半以上的非空行**含有路径或网址 token ——
 * 普通源码块（`const x = 1`）不会有这个密度，不会被误判成清单。
 *
 * 网址也算进来（用户 2026-11-10）：模型经常把三套环境的地址贴成一个代码块，
 * 那时候用户想要的正是**逐行可点**（新标签页打开），而不是一块不能点的等宽文字。
 * 代价是这种块不再上色 —— 与路径清单同理：可点比好看重要，这类块本来也没什么语法。
 */
export function looksLikePathListing(text: string): boolean {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length < 2) return false;
	const hits = lines.filter((line) =>
		pathTokens(line).some((part) => part.path !== undefined || part.url !== undefined),
	).length;
	return hits * 2 >= lines.length;
}
