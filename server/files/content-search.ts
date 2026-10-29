/**
 * 全文搜索（**文件内容** grep）—— 文件名搜索是 file-search.ts 的活，这里是「这行字出现在哪」。
 *
 * 为什么自己走一遍目录、不直接 `rg`：这个工作台要能在没装 ripgrep 的机器上开箱就用，
 * 也不想为一次搜索多进程一个不稳定的外部依赖。代价是自己得把「别扫的东西」列清楚：
 *   - 跳过 node_modules / .git / dist 之类的重目录（复用 file-service 的 IGNORED_ENTRIES）；
 *   - 跳过符号链接（可能成环）、跳过二进制（含 NUL 字节）、跳过超过 512KB 的文件；
 *   - 文件数 / 结果数都有上限，超了就 `truncated: true` —— 界面明确说「只显示前 N 条」，
 *     比让人等到怀疑卡死强。
 *
 * 匹配大小写不敏感（跟文件名搜索一个口径）：找代码时记得住字、记不住大小写。
 * 每行最多回一条命中：一屏里同一行出现五次同一个词，列五条只会把别的结果挤下去。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { toPosixPath } from "../util/paths.js";
import { isIgnoredEntry } from "./file-service.js";

const GREP_MAX_RESULTS = 200;
const GREP_MAX_FILES = 20000;
const GREP_MAX_FILE_BYTES = 512 * 1024;
/** 单行最多回多少字（长的压缩行 / 生成的 JSON 别把整屏撑爆） */
const GREP_LINE_CHARS = 400;
const GREP_MAX_DEPTH = 12;

export type ContentMatch = {
	/** 相对工作区的 posix 路径 */
	path: string;
	/** 1-based 行号 */
	line: number;
	/** 该行文本（去掉行尾空白；超长时取命中附近的一段） */
	text: string;
	/** 命中在 `text` 里的起始列（0-based，界面按它加高亮） */
	column: number;
};

type ContentSearchResult =
	{ ok: true; matches: ContentMatch[]; files: number; truncated: boolean } | { ok: false; error: string };

/** 正则里的特殊字符（逐个转义；glob 只认 `*` `**` `?`，其余按字面） */
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * 简易 glob → 正则：`*` 不跨目录、`**` 跨目录、`?` 一个字符。
 * 空模式回 null（= 不筛）。
 */
function globToRegExp(glob: string): RegExp | null {
	const pattern = glob.trim();
	if (pattern === "") return null;
	let out = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				// `**/` = 任意层目录（含零层）；尾部的 `**` = 任意字符
				if (pattern[index + 1] === "/") {
					index += 1;
					out += "(?:[^/]+/)*";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		out += char.replace(REGEX_SPECIAL, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/**
 * 路径要不要搜：
 *   - 带 `/` 的模式匹配整条相对路径（`src/**\/*.ts`）；
 *   - 不带的只看文件名（`*.ts` = 所有 ts），这是最常用的一种；
 *   - 一个通配符都没有的纯词按「包含」处理（`ts` → `*ts*`），省得人人先学 glob。
 */
function matchesGlob(path: string, glob: string): boolean {
	const pattern = glob.trim();
	if (pattern === "") return true;
	const effective = /[*?]/.test(pattern) ? pattern : `*${pattern}*`;
	const regex = globToRegExp(effective);
	if (!regex) return true;
	const target = effective.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
	return regex.test(target);
}

/**
 * 把一行文本裁成「看得见命中」的一段。
 * 长行（压缩过的 JSON 之类）从命中前留 40 字开始截 —— 只留开头的话，命中在 3000 列就白截了。
 */
function lineWindow(raw: string, at: number): { text: string; column: number } {
	const trimmed = raw.replace(/\s+$/, "");
	// 行首缩进也算「有效内容」：从行首开始截时保持原样（缩进很有信息量），但命中离行首太远就平移窗口
	const lead = trimmed.length - trimmed.trimStart().length;
	let start = 0;
	if (trimmed.length - lead > GREP_LINE_CHARS)
		start = Math.max(lead, Math.min(at - 40, trimmed.length - GREP_LINE_CHARS));
	return { text: trimmed.slice(start, start + GREP_LINE_CHARS), column: Math.max(0, at - start) };
}

/** 扫一个文件：返回它里面所有命中的行（每行一条） */
async function scanFile(
	absPath: string,
	relPath: string,
	needleLower: string,
	maxResults: number,
): Promise<ContentMatch[]> {
	try {
		const info = await stat(absPath);
		if (!info.isFile() || info.size === 0 || info.size > GREP_MAX_FILE_BYTES) return [];
		const buffer = await readFile(absPath);
		// 二进制（含 NUL 字节）直接跳过：图片 / 压缩包 / 编译产物
		if (buffer.includes(0)) return [];
		const lines = buffer.toString("utf8").split(/\r?\n/);
		const found: ContentMatch[] = [];
		for (let index = 0; index < lines.length; index += 1) {
			if (found.length >= maxResults) break;
			const raw = lines[index];
			const at = raw.toLowerCase().indexOf(needleLower);
			if (at < 0) continue;
			const { text, column } = lineWindow(raw, at);
			found.push({ path: relPath, line: index + 1, text, column });
		}
		return found;
	} catch {
		return []; // 没权限 / 刚被删：跳过，不因为一个文件中断整次搜索
	}
}

export async function searchFileContents(
	root: string,
	query: string,
	options: { glob?: string; maxResults?: number; maxFiles?: number } = {},
): Promise<ContentSearchResult> {
	const needle = query.trim();
	if (needle === "") return { ok: true, matches: [], files: 0, truncated: false };
	const needleLower = needle.toLowerCase();
	const glob = options.glob ?? "";
	const maxResults = options.maxResults ?? GREP_MAX_RESULTS;
	const maxFiles = options.maxFiles ?? GREP_MAX_FILES;
	const matches: ContentMatch[] = [];
	let files = 0;
	let truncated = false;

	/** 广度优先：浅层的文件先出结果，界面看起来「立刻就动了」 */
	const walk = async (dir: string, relPath: string, depth: number): Promise<void> => {
		if (depth > GREP_MAX_DEPTH || matches.length >= maxResults) return;
		let items;
		try {
			items = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const dirs: { path: string; rel: string }[] = [];
		for (const item of items) {
			if (isIgnoredEntry(item.name)) continue;
			// 符号链接不跟：可能指回上层成环，也可能指到工作区外面去
			if (item.isSymbolicLink()) continue;
			const childRel = toPosixPath(relPath === "" ? item.name : `${relPath}/${item.name}`);
			if (item.isDirectory()) {
				dirs.push({ path: join(dir, item.name), rel: childRel });
				continue;
			}
			if (!item.isFile()) continue;
			if (!matchesGlob(childRel, glob)) continue;
			if (files >= maxFiles) {
				truncated = true;
				return;
			}
			files += 1;
			const found = await scanFile(join(dir, item.name), childRel, needleLower, maxResults - matches.length);
			matches.push(...found);
			if (matches.length >= maxResults) {
				truncated = true;
				return;
			}
		}
		for (const child of dirs) {
			await walk(child.path, child.rel, depth + 1);
			if (matches.length >= maxResults) {
				truncated = true;
				return;
			}
		}
	};

	try {
		await walk(root, "", 0);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	// 排序：先按路径（跟文件树一个方向），再按行号 —— 同一文件的结果聚在一起才好读
	matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
	return { ok: true, matches: matches.slice(0, maxResults), files, truncated };
}
