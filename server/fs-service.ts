/**
 * FsService — 实现浏览器侧的 `omaw/fs/list`、`omaw/fs/read`、`omaw/paths`。
 *
 * 这是一个本地开发工具，不做沙箱根限制；但：
 *  - 对目录项使用 lstat，symlink 只报告为 symlink，不跟随展开；
 *  - 读取时检测 NUL 字节，二进制文件明确拒绝而不是返回乱码；
 *  - 所有错误以带 code 的 FsError 抛出，由 index 转成 JSON-RPC error。
 */
import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { CwPaths, FsEntry } from "../shared/protocol.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_BYTES_LIMIT = 16 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const BINARY_SNIFF_BYTES = 8_000;

export class FsError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = "FsError";
		this.code = code;
	}
}

/** `~` / `~/x` 展开；相对路径基于 cwd。 */
export function expandHome(input: string, home = homedir()): string {
	if (input === "~") return home;
	if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
	return input;
}

export function toAbsolute(input: string, cwd: string, home = homedir()): string {
	const expanded = expandHome(input, home);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function paths(cwd: string, codexHome: string): CwPaths {
	return { cwd, home: homedir(), codexHome };
}

export interface ListResult {
	path: string;
	entries: FsEntry[];
}

export async function listDirectory(opts: {
	path?: string;
	cwd: string;
	maxEntries?: number;
}): Promise<ListResult> {
	const home = homedir();
	const target = toAbsolute(opts.path?.trim() || ".", opts.cwd, home);
	const maxEntries = Math.max(1, Math.min(opts.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES));

	let dirents;
	try {
		dirents = await readdir(target, { withFileTypes: true });
	} catch (err) {
		throw toFsError(err, target);
	}

	// 若用户明确进入 node_modules/.git 内部，就不再跳过它们（否则无法浏览）。
	const segments = target.split(sep);
	const insideSkipped = segments.includes("node_modules") || segments.includes(".git");

	const entries: FsEntry[] = [];
	for (const dirent of dirents) {
		if (!insideSkipped && (dirent.name === "node_modules" || dirent.name === ".git")) continue;
		const full = join(target, dirent.name);
		let size = 0;
		let mtime = 0;
		let kind: FsEntry["kind"];
		try {
			// lstat：symlink 本身不被展开，避免指向目录外。
			const st = await lstat(full);
			size = st.size;
			mtime = st.mtimeMs;
			kind = st.isDirectory()
				? "directory"
				: st.isSymbolicLink()
					? "symlink"
					: st.isFile()
						? "file"
						: "other";
		} catch {
			kind = dirent.isDirectory() ? "directory" : dirent.isSymbolicLink() ? "symlink" : "file";
		}
		entries.push({ name: dirent.name, path: full, kind, size, mtime });
		if (entries.length >= maxEntries) break;
	}

	// 目录优先，其余按名字。
	entries.sort((a, b) => {
		const ad = a.kind === "directory" ? 0 : 1;
		const bd = b.kind === "directory" ? 0 : 1;
		if (ad !== bd) return ad - bd;
		return a.name.localeCompare(b.name);
	});

	return { path: target, entries };
}

export interface ReadResult {
	path: string;
	text: string;
	truncated: boolean;
}

export async function readTextFile(opts: {
	path: string;
	cwd: string;
	maxBytes?: number;
}): Promise<ReadResult> {
	if (!opts.path || !opts.path.trim()) throw new FsError(-32602, "path is required");
	const home = homedir();
	const target = toAbsolute(opts.path, opts.cwd, home);
	const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT));

	try {
		const st = await stat(target);
		if (st.isDirectory()) throw new FsError(-32000, `is a directory: ${target}`);
	} catch (err) {
		if (err instanceof FsError) throw err;
		throw toFsError(err, target);
	}

	let handle;
	try {
		handle = await open(target, "r");
	} catch (err) {
		throw toFsError(err, target);
	}
	try {
		// 多读 1 字节用于判断是否 truncated。
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > maxBytes;
		const usable = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		const sniff = usable.subarray(0, Math.min(usable.length, BINARY_SNIFF_BYTES));
		if (sniff.includes(0)) throw new FsError(-32000, `binary file, refusing to read as text: ${target}`);
		return { path: target, text: usable.toString("utf8"), truncated };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function toFsError(err: unknown, target: string): FsError {
	const e = err as NodeJS.ErrnoException;
	switch (e?.code) {
		case "ENOENT":
			return new FsError(-32000, `not found: ${target}`);
		case "EACCES":
		case "EPERM":
			return new FsError(-32000, `permission denied: ${target}`);
		case "ENOTDIR":
			return new FsError(-32000, `not a directory: ${target}`);
		case "EISDIR":
			return new FsError(-32000, `is a directory: ${target}`);
		default:
			return new FsError(-32000, e?.message ? `${e.message}: ${target}` : `fs error: ${target}`);
	}
}
