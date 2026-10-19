/**
 * 文件浏览与只读预览（M4）——服务端。
 *
 * 三条硬约束：
 *   1. **只能看当前项目内**（ADR-0006）：所有路径 `realpath` 后必须落在工作区根内；
 *   2. **懒加载**：列目录只列一层（91 个会话那种大目录也不卡）；
 *   3. **有上限**：预览只读前 N 字节，二进制给「不可预览」而不是塞满界面。
 */
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInsideRoot } from "../util/paths.js";

export const MAX_PREVIEW_BYTES = 512 * 1024;
/** 默认不列的目录/文件（与参考实现的 IGNORED_ENTRIES 同口径：依赖与构建产物不该占满文件树） */
export const IGNORED_ENTRIES = new Set(["node_modules", ".git", "dist", "web/dist", "coverage", ".next", "target"]);

/** 目录里最多列多少项（防止某个目录把界面撑爆） */
export const MAX_DIR_ENTRIES = 500;

export type FileEntry = { name: string; path: string; isDir: boolean };

export type ListResult =
	{ ok: true; root: string; path: string; entries: FileEntry[]; truncated: boolean } | { ok: false; error: string };

export type PreviewResult =
	| { ok: true; path: string; text: string; bytes: number; truncated: boolean; binary: boolean }
	| { ok: false; error: string };

/** 纯函数：按「目录优先、同类按名字」排序（与常见文件树一致） */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
	return [...entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** 纯函数：看起来像文本吗（NUL 字节 = 二进制；常见图片扩展名直接判二进制） */
export function looksBinary(bytes: Uint8Array, name: string): boolean {
	if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dylib|so|woff2?|ttf|mp4|mp3|wav)$/i.test(name)) return true;
	const sample = bytes.subarray(0, 4096);
	for (const byte of sample) if (byte === 0) return true;
	return false;
}

export async function listDirectory(root: string, relPath: string): Promise<ListResult> {
	const target = relPath === "" ? root : join(root, relPath);
	const safe = resolveInsideRoot(root, target, realpathSync);
	if (!safe.ok) return { ok: false, error: safe.reason };

	try {
		const items = await readdir(safe.path, { withFileTypes: true });
		const entries: FileEntry[] = items
			.filter((item) => !IGNORED_ENTRIES.has(item.name))
			.filter((item) => !item.name.startsWith(".") || item.name === ".gitignore" || item.name === ".env.example")
			.map((item) => ({ name: item.name, path: join(relPath, item.name), isDir: item.isDirectory() }));
		return {
			ok: true,
			root,
			path: relPath,
			entries: sortEntries(entries).slice(0, MAX_DIR_ENTRIES),
			truncated: entries.length > MAX_DIR_ENTRIES,
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function readPreview(root: string, relPath: string, limit = MAX_PREVIEW_BYTES): Promise<PreviewResult> {
	const safe = resolveInsideRoot(root, join(root, relPath), realpathSync);
	if (!safe.ok) return { ok: false, error: safe.reason };

	try {
		const info = await stat(safe.path);
		if (info.isDirectory()) return { ok: false, error: "这是一个目录" };
		const handle = await readFile(safe.path);
		const bytes = handle.byteLength > limit ? handle.subarray(0, limit) : handle;
		const binary = looksBinary(bytes, safe.path);
		return {
			ok: true,
			path: relPath,
			text: binary ? "" : bytes.toString("utf8"),
			bytes: handle.byteLength,
			truncated: handle.byteLength > limit,
			binary,
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
