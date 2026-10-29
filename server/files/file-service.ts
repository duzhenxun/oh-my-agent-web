/**
 * 文件浏览与只读预览（M4）——服务端。
 *
 * 三条硬约束：
 *   1. **只能看当前项目内**（ADR-0006）：所有路径 `realpath` 后必须落在工作区根内；
 *   2. **懒加载**：列目录只列一层（91 个会话那种大目录也不卡）；
 *   3. **有上限**：预览只读前 N 字节，二进制给「不可预览」而不是塞满界面。
 */
import { realpathSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveInsideRoot, toPosixPath } from "../util/paths.js";

const MAX_PREVIEW_BYTES = 512 * 1024;
/**
 * 默认不列的目录/文件（依赖与构建产物不该占满文件树）。
 *
 * **全部存小写**：Windows 文件系统不区分大小写，`Node_Modules` 与 `node_modules` 是同一个目录，
 * 用原大小写去 `has()` 会让这些目录在 Windows 上照常出现（树被撑大、搜索变慢）。
 * 后半段是 Windows 的目录噪音：资源管理器默认隐藏，我们不隐藏就会看到一片 `$RECYCLE.BIN` 之类。
 */
export const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	"dist",
	"coverage",
	".next",
	"target",
	// Windows：系统/隐藏噪聲（dotfile 那套约定在那边不适用）
	"desktop.ini",
	"thumbs.db",
	"$recycle.bin",
	"system volume information",
	"pagefile.sys",
	"hiberfil.sys",
	"swapfile.sys",
	"dumpstack.log.tmp",
	"$winreagent",
	"recovery",
]);

/** 纯函数：这个条目名是否该被忽略（大小写无关） */
export function isIgnoredEntry(name: string): boolean {
	return IGNORED_ENTRIES.has(name.toLowerCase());
}

/** 目录里最多列多少项（防止某个目录把界面撑爆） */
const MAX_DIR_ENTRIES = 500;

export type FileEntry = { name: string; path: string; isDir: boolean };

type ListResult =
	{ ok: true; root: string; path: string; entries: FileEntry[]; truncated: boolean } | { ok: false; error: string };

type PreviewResult =
	| { ok: true; path: string; text: string; bytes: number; truncated: boolean; binary: boolean }
	| { ok: false; error: string };

/** 纯函数：按「目录优先、同类按名字」排序（与常见文件树一致） */
function sortEntries(entries: FileEntry[]): FileEntry[] {
	return [...entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** 纯函数：看起来像文本吗（NUL 字节 = 二进制；常见图片扩展名直接判二进制） */
function looksBinary(bytes: Uint8Array, name: string): boolean {
	if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dylib|so|woff2?|ttf|mp4|mp3|wav)$/i.test(name)) return true;
	const sample = bytes.subarray(0, 4096);
	for (const byte of sample) if (byte === 0) return true;
	return false;
}

/**
 * 列一层目录。
 *
 * `showHidden` 控制**点开头的隐藏文件**（.env / .github 之类）：默认只放行 .gitignore 与 .env.example
 * （它们是项目说明的一部分），需要时由界面的「眼睛」按钮显式打开。
 * `node_modules` / `dist` 这类永远不列（ADR：依赖与构建产物不该占满文件树）。
 */
export async function listDirectory(
	root: string,
	relPath: string,
	options: { showHidden?: boolean } = {},
): Promise<ListResult> {
	const target = relPath === "" ? root : join(root, relPath);
	const safe = resolveInsideRoot(root, target, realpathSync);
	if (!safe.ok) return { ok: false, error: safe.reason };

	try {
		const items = await readdir(safe.path, { withFileTypes: true });
		const entries: FileEntry[] = items
			.filter((item) => !isIgnoredEntry(item.name))
			.filter(
				(item) =>
					options.showHidden === true ||
					!item.name.startsWith(".") ||
					item.name === ".gitignore" ||
					item.name === ".env.example",
			)
			.map((item) => ({ name: item.name, path: toPosixPath(join(relPath, item.name)), isDir: item.isDirectory() }));
		return {
			ok: true,
			root,
			path: toPosixPath(relPath),
			entries: sortEntries(entries).slice(0, MAX_DIR_ENTRIES),
			truncated: entries.length > MAX_DIR_ENTRIES,
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function readPreview(root: string, relPath: string, limit = MAX_PREVIEW_BYTES): Promise<PreviewResult> {
	/**
	 * 绝对路径：模型/工具给出的**真实地址**（正文里常只写文件名，点开时已经换回绝对路径），
	 * 直接按它读。相对路径仍必须落在工作区内（ADR-0006：realpath 之后在根内）。
	 * 工作区外的绝对路径放行与 `readRaw` 对 `/tmp` 截图的放行同口径 —— 单用户工作台的边界是**只读**，
	 * 而「点了模型刚读过的那个文件」本身就已经是用户的明确意图。
	 */
	let filePath: string;
	if (isAbsolute(relPath)) {
		try {
			filePath = realpathSync(relPath);
		} catch {
			return { ok: false, error: `路径不存在或无法解析：${relPath}` };
		}
	} else {
		const safe = resolveInsideRoot(root, join(root, relPath), realpathSync);
		if (!safe.ok) return { ok: false, error: safe.reason };
		filePath = safe.path;
	}

	try {
		const info = await stat(filePath);
		if (info.isDirectory()) return { ok: false, error: "这是一个目录" };
		// 只读前 limit 字节：以前是 readFile 全读进来再截断（工作区里一个几 GB 的日志
		// 就能把进程内存打爆），512KB 的上限等于没设。
		const size = info.size;
		const take = Math.min(size, limit);
		const handle = await open(filePath, "r");
		let bytes: Buffer;
		try {
			bytes = Buffer.alloc(take);
			if (take > 0) await handle.read(bytes, 0, take, 0);
		} finally {
			await handle.close();
		}
		const binary = looksBinary(bytes, filePath);
		return {
			ok: true,
			path: relPath,
			text: binary ? "" : bytes.toString("utf8"),
			bytes: size,
			truncated: size > limit,
			binary,
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 允许直接当图片/文档发给浏览器的扩展名（其余一律拒绝，避免变成任意文件下载器） */
const RAW_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	bmp: "image/bmp",
	pdf: "application/pdf",
	// html 报告（agent 生成的「报告」多是单文件 html）：预览面板要能把**页面**渲染出来。
	// 只放行 html/htm：JS/CSS 不额外开口子，报告自己内联；外链走网络。
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
};

/** 图片原始大小上限（超过就拒绝，别让浏览器卡死） */
const MAX_RAW_BYTES = 20 * 1024 * 1024;

type RawResult = { ok: true; bytes: Buffer; mime: string } | { ok: false; error: string; tooLarge?: boolean };

/** 纯函数：按扩展名给 Content-Type（不在白名单里返回空串 = 拒绝） */
function mimeOf(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return RAW_MIME[extension] ?? "";
}

/** 读取图片原始字节（markdown 里 \`![](docs/shot.png)\` 能直接显示的关键一环） */
export async function readRaw(root: string, relPath: string): Promise<RawResult> {
	const mime = mimeOf(relPath);
	if (mime === "") return { ok: false, error: `不支持的文件类型：${relPath.split(".").pop() ?? "无扩展名"}` };
	// 绝对路径（agent 把截图写到 /tmp/x.png 这种）：只做「存在 + 是文件 + 类型白名单」，
	// 不做工作区包含 —— 否则模型刚生成的图在对话里就看不见。相对路径仍限制在工作区内。
	let safe: { ok: true; path: string } | { ok: false; reason: string };
	try {
		safe = isAbsolute(relPath)
			? { ok: true, path: realpathSync(relPath) }
			: resolveInsideRoot(root, join(root, relPath), realpathSync);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!safe.ok) return { ok: false, error: safe.reason };
	try {
		const info = await stat(safe.path);
		if (info.isDirectory()) return { ok: false, error: "这是一个目录" };
		if (info.size > MAX_RAW_BYTES) return { ok: false, error: "文件太大（上限 20MB）", tooLarge: true };
		return { ok: true, bytes: await readFile(safe.path), mime };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// 视频 / 音频：走「流 + Range」，不整块读进内存（大文件也能拖动进度条）
// ---------------------------------------------------------------------------

/** 允许内联播放的媒体类型（白名单之外的扩展名一律拒绝） */
const MEDIA_MIME: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/opus",
	flac: "audio/flac",
};

/** 纯函数：媒体扩展名 → Content-Type（不是媒体返回空串） */
function mediaMimeOf(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return MEDIA_MIME[extension] ?? "";
}

type MediaFile =
	{ ok: true; path: string; size: number; mime: string } | { ok: false; error: string; tooLarge?: boolean };

/**
 * 解析一个可播放的媒体文件：校验路径（与 readRaw 同规矩）、类型白名单、大小上限。
 * 只 stat，不读内容 —— 真正的字节由路由用 createReadStream + Range 流出去。
 */
export async function resolveMediaFile(root: string, relPath: string): Promise<MediaFile> {
	const mime = mediaMimeOf(relPath);
	if (mime === "") return { ok: false, error: `不支持的媒体类型：${relPath.split(".").pop() ?? "无扩展名"}` };
	let safePath: string;
	try {
		safePath = isAbsolute(relPath) ? realpathSync(relPath) : "";
		if (safePath === "") {
			const safe = resolveInsideRoot(root, join(root, relPath), realpathSync);
			if (!safe.ok) return { ok: false, error: safe.reason };
			safePath = safe.path;
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const info = await stat(safePath);
		if (info.isDirectory()) return { ok: false, error: "这是一个目录" };
		if (info.size > MAX_MEDIA_BYTES) return { ok: false, error: "文件太大（上限 4GB）", tooLarge: true };
		return { ok: true, path: safePath, size: info.size, mime };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 媒体文件大小上限：4GB（流式发送，不会占内存；只是别把「伪装的巨型文件」当视频播） */
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

/** 纯函数：解析 Range 头（只认单段 `bytes=a-b`），返回闭区间；无效返回 null（按整文件发） */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
	if (!header) return null;
	// 空文件：下面两个分支都会算出 `end: -1`，传给 createReadStream 会同步抛 ERR_OUT_OF_RANGE
	// （那时响应头已发出，连接直接被掐断）—— 直接当作「没范围」按整文件发
	if (size <= 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, rawStart, rawEnd] = match;
	if (rawStart === "" && rawEnd === "") return null;
	if (rawStart === "") {
		// 后缀写法：bytes=-N → 最后 N 字节
		const length = Number(rawEnd);
		if (!Number.isFinite(length) || length <= 0) return null;
		return { start: Math.max(0, size - length), end: size - 1 };
	}
	const start = Number(rawStart);
	const end = rawEnd === "" ? size - 1 : Number(rawEnd);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
	return { start: Math.min(start, size - 1), end: Math.min(end, size - 1) };
}
