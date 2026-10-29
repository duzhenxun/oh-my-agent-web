/**
 * 输入框里的「@ 提及」：识别 / 补全 / 把路径转成引用串（纯函数，不碰 DOM、不发请求）。
 *
 * 形状对齐仓库里已有的 `@path` 引用：文件树悬浮的「@ 提及」和文件预览的「添加到对话」
 * 写进草稿的都是 `file-preview.ts` 的 `referenceFor()`（`@路径` 或 `@路径:10-20`）。
 * 所以这里也只产生 `@路径`，模型收到的就是一条普通的自然语言 + 路径引用，不需要新的协议。
 *
 * 三条规则值得记一下：
 *   1. `@` 只有在**词首**才触发（前面是行首或空白），所以 `foo@bar.com` 不会弹面板；
 *   2. 光标往前扫到空白就停 —— `@` 与光标之间不允许有空格，这样打完路径按回车就不会误触发；
 *   3. 工作区里的文件写**相对路径**（和文件树一致、也更好读），工作区外的写绝对路径。
 */
import { basename, normalizeCwd } from "./path-utils.ts";

/** 跟着 `@` 一起被替换掉的那一段：`@` 的位置 + 光标（从 `start` 到 `end` 就是用户敲的关键字） */
export type MentionInput = { start: number; end: number; term: string };

/** 搜索关键字太长时不再弹面板（那更像用户在正文里写地址，而不是在挑文件） */
const MAX_TERM_LENGTH = 160;

/** 触发 `@` 时允许出现在它前面的字符：行首 / 空白 / 几个常见的中文与英文起头标点 */
const ALLOWED_BEFORE = new Set(["", " ", "\t", "\n", "（", "(", "【", "[", "「", "《", '"', "'", "`", "：", ":"]);

/**
 * 当前光标处是不是一个「正在输入的 @ 提及」。
 *
 * 返回 `null` = 不在提及里（面板该关掉）。`end` 取光标位置，不是整段文字的末尾 ——
 * 用户可以在 `@js|` 中间补字，替换时也只该吃掉 `@` 到光标这一段。
 */
export function parseMentionInput(text: string, caret: number): MentionInput | null {
	const position = Math.min(Math.max(caret, 0), text.length);
	let at = -1;
	for (let index = position - 1; index >= 0; index -= 1) {
		const character = text[index] ?? "";
		if (character === "@") {
			at = index;
			break;
		}
		// 空白 = 这个 `@` 已经是很久以前打的字了（或者压根不是一个提及）
		if (/\s/.test(character)) return null;
	}
	if (at < 0) return null;
	const before = at === 0 ? "" : (text[at - 1] ?? "");
	if (!ALLOWED_BEFORE.has(before)) return null;
	const term = text.slice(at + 1, position);
	if (term.length > MAX_TERM_LENGTH) return null;
	return { start: at, end: position, term };
}

/**
 * 把选中的文件/目录填进草稿：`@js` + `web-push/server.js` → `@web-push/server.js |`。
 *
 * 末尾补一个空格（后面通常紧接着写要求），光标停在空格之后；如果原文那儿本来就有空白，
 * 就不重复补 —— 否则会出现两个空格，看着像手滑。
 */
export function applyMention(text: string, mention: MentionInput, path: string): { text: string; caret: number } {
	return spliceReference(text, mention.start, mention.end, path);
}

/**
 * 光标处没有 `@关键字` 时（按 Esc 关过面板、或原生选择框回来后 token 已不在）就纯插入。
 * 不替换任何已有文字 —— 用户已经写好的句子不能因为点了一个文件就少一段。
 */
export function insertReference(text: string, caret: number, path: string): { text: string; caret: number } {
	const at = Math.min(Math.max(caret, 0), text.length);
	return spliceReference(text, at, at, path);
}

/** 把 `[start, end)` 换成 `@路径 `，返回新文本与应当落下的光标位置 */
function spliceReference(text: string, start: number, end: number, path: string): { text: string; caret: number } {
	const reference = `@${path}`;
	const tail = text.slice(end);
	const startsWithSpace = /^\s/.test(tail);
	// 后面本来就跟着空白就不重复补空格；但光标要**跨过**那一个，
	// 否则用户接着敲的字会粘在路径后面（`@a/b.ts这个`）
	const gap = tail === "" || !startsWithSpace ? " " : "";
	const next = text.slice(0, start) + reference + gap + tail;
	return { text: next, caret: start + reference.length + (gap === "" && startsWithSpace ? 1 : gap.length) };
}

/** 像不像一条绝对路径（`/a/b`、`C:\a\b`、`\\server\share`）—— 只做字符串判断，不碰文件系统 */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** 纯函数：`target` 在 `root` 里面时给出相对路径（`/` 分隔），不在里面（或比的不出来）给 `null` */
export function relativeInside(root: string, target: string): string | null {
	const base = normalizeCwd(root);
	const full = normalizeCwd(target);
	if (base === "" || full === "") return null;
	// Windows 盘符大小写不敏感；路径分隔符两边都可能混着来，按段比
	const windows = /^[A-Za-z]:/.test(base);
	const baseParts = base.split(/[\\/]+/).filter((part) => part !== "");
	const fullParts = full.split(/[\\/]+/).filter((part) => part !== "");
	if (baseParts.length === 0 || baseParts.length > fullParts.length) return null;
	for (let index = 0; index < baseParts.length; index += 1) {
		const left = baseParts[index] ?? "";
		const right = fullParts[index] ?? "";
		if (windows ? left.toLowerCase() !== right.toLowerCase() : left !== right) return null;
	}
	return fullParts.slice(baseParts.length).join("/");
}

/**
 * 写进草稿的路径形态：能落回工作区就写相对路径，否则原样写绝对路径。
 *
 * 为什么相对优先：文件树、预览、`referenceFor()` 给的都是相对路径，同一个文件在对话里
 * 应该只有一种写法（否则模型看到两种写法、人也分不清是不是两个文件）。
 */
export function mentionPathFor(path: string, root: string | null): string {
	const value = path.trim();
	if (value === "" || !isAbsolutePath(value)) return value;
	if (root) {
		const relative = relativeInside(root, value);
		if (relative !== null) return relative === "" ? "." : relative;
	}
	return value;
}

/** 搜索命中的文件（相对路径）/ 挑过的文件（可能是绝对路径）—— 面板里的一行 */
export type MentionRow =
	| { kind: "browse"; target: "file" | "dir"; group: "browse" }
	| { kind: "file"; name: string; path: string; isDir: boolean; group: "recent" | "result" };

/** 一个「挑过的路径」：跟着项目根存，换项目就不会拿上一个项目的相对路径去引用 */
export type MentionRecent = { path: string; isDir: boolean };

/** 面板最多列多少条：再多也翻不动，滚轮比键盘还慢 */
export const MENTION_MAX_ROWS = 40;

/**
 * 面板要显示的行（顺序 = ↑↓ 顺序）。
 *
 * 关键是一个「空关键字」的分岔（用户 2026-10-29 定的）：
 *   - 只打了 `@`：最上面先给「文件和文件夹」——那是唯一能从电脑里现挑一个进来（拿到真路径）的入口，
 *     下面跟「最近用过」；
 *   - 打了 `@js`：只列搜索命中的文件，不再让「挑选入口」占住第一条（那时用户要的是那个文件）。
 */
export function buildMentionRows(options: {
	term: string;
	results: readonly MentionRecent[];
	recent: readonly MentionRecent[];
}): MentionRow[] {
	const rows: MentionRow[] = [];
	if (options.term.trim() === "") {
		rows.push({ kind: "browse", target: "file", group: "browse" });
		rows.push({ kind: "browse", target: "dir", group: "browse" });
		for (const item of options.recent.slice(0, MENTION_MAX_ROWS - rows.length))
			rows.push({ kind: "file", name: basename(item.path), path: item.path, isDir: item.isDir, group: "recent" });
		return rows;
	}
	for (const item of options.results.slice(0, MENTION_MAX_ROWS))
		rows.push({ kind: "file", name: basename(item.path), path: item.path, isDir: item.isDir, group: "result" });
	return rows;
}
