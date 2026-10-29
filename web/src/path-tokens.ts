/**
 * 消息里的「文件路径」识别 + 点击打开。
 *
 * 为什么单独一个模块：报告类回复（agent 跑完自测/审查）经常直接贴一段路径清单，
 * 用户想点开看却只能自己去文件树里翻。这里给两条能力：
 *   1. `looksLikePath` / `pathTokens`：判断一段文字里哪些是文件路径（纯函数，好测）；
 *   2. `setPathOpener` / `openPathFromMessage`：Markdown 渲染层深在组件树里，
 *      用模块级回调把「点路径 → 在右侧面板预览」接线进来，避免层层传 prop。
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

/** 一个「像路径」的 token：可带 ~ / 相对前缀，末段要有扩展名 */
const TOKEN = /(?:~\/|\.{0,2}\/)?[\w@.\-/（）()\u4e00-\u9fff]+\.([A-Za-z0-9]{1,8})\b/g;

/** 这段文字是不是一个文件路径（用于行内代码：`docs/report.html`） */
export function looksLikePath(text: string): boolean {
	const value = text.trim();
	if (value === "" || value.length > 300) return false;
	if (/\s/.test(value)) return false; // 带空格的一律不认（命令、句子）
	const match = /^[^\s]+\.([A-Za-z0-9]{1,8})$/.exec(value);
	if (!match) return false;
	if (!FILE_EXTENSIONS.has(match[1]!.toLowerCase())) return false;
	// 至少要有个路径分隔符，或者本来就带扩展名的纯文件名（README.md）
	return true;
}

/**
 * 把一段文本切成「文本 / 路径」片段（代码块里逐行调用）。
 * 只认白名单扩展名，其余原样返回成文本。
 */
export function pathTokens(line: string): { text: string; path?: string }[] {
	const parts: { text: string; path?: string }[] = [];
	let last = 0;
	for (const match of line.matchAll(TOKEN)) {
		const token = match[0];
		const ext = (match[1] ?? "").toLowerCase();
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
 * 这段代码块像不像「路径清单」：报告里的目录树 / 产物列表。
 * 判据：≥2 行，且**一半以上的非空行**含有路径 token ——
 * 普通源码块（`const x = 1`）不会有这个密度，不会被误判成清单。
 */
export function looksLikePathListing(text: string): boolean {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length < 2) return false;
	const hits = lines.filter((line) => pathTokens(line).some((part) => part.path !== undefined)).length;
	return hits * 2 >= lines.length;
}
