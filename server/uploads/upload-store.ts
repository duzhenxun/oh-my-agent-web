/**
 * 附件上传的存储（ADR-0020 §P3）。
 *
 * 三条硬约束（都来自既有 ADR）：
 *   1. **图片不塞 WS**（ADR-0004 单条 ≤64KB）：走 HTTP 上传，消息里只带引用 id；
 *   2. **id 必须防目录穿越**（ADR-0006 的精神）：只接受 `[a-z0-9-]`，其余一律拒；
 *   3. **有清理**：上传目录不能无限长大 → 按时间清理旧文件（每次上传时顺手跑）。
 *
 * 不做的事：非图片文件的内容注入（ADR-0002 的原则：只给路径引用）。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const UPLOADS_DIR = "uploads";
/** 单文件上限（与 ADR-0020 §P3 一致） */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 上传文件保留期（默认 7 天） */
const DEFAULT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ID_RE = /^[a-z0-9-]{8,64}$/;

export function uploadsDir(dataDir: string): string {
	return join(dataDir, UPLOADS_DIR);
}

/** 纯函数：id 是否安全（防 `../` 与绝对路径） */
function isSafeUploadId(id: string): boolean {
	return ID_RE.test(id);
}

/**
 * 纯函数：把用户给的文件名收敛成「能拼进磁盘路径的一段后缀」。
 *
 * 为什么存盘时要带原名（用户 2026-11-26）：模型拿到的提示词里写的是**磁盘路径** ——
 * 只给 `<id>` 的话，`/Users/x/.oh-my-agent-web/uploads/a1b2c3d4` 这种没有扩展名的串既看不出
 * 是什么文件，也看不出该用哪种方式读。所以落盘名是 `<id>-<清洗过的原名>`。
 *
 * 保留：字母 / 数字 / `.` `_` `-`（含中文等各语种字母）；其余一律换成 `_`，
 * 去掉开头的点（不能变成隐藏文件），长度封顶 80。
 */
function safeNameSuffix(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^\.+/, "")
		.slice(0, 80);
	return cleaned === "" ? "" : `-${cleaned}`;
}

/**
 * 找到某个 id 对应的落盘文件：先试老的 `<id>`（存量上传），再找 `<id>-<原名>`。
 * 返回绝对路径；找不到返回 null。
 */
async function storedPath(dir: string, id: string): Promise<string | null> {
	if (!isSafeUploadId(id)) return null;
	const exact = join(dir, id);
	try {
		await stat(exact);
		return exact;
	} catch {
		// 不是存量那种无后缀命名，往下找带原名的
	}
	try {
		const names = await readdir(dir);
		const hit = names.find((name) => name.startsWith(`${id}-`));
		return hit === undefined ? null : join(dir, hit);
	} catch {
		return null;
	}
}

/** 纯函数：按魔术字节嗅探类型（不信任客户端给的 content-type） */
function sniffMime(bytes: Uint8Array): string | null {
	const head = bytes.subarray(0, 12);
	const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
	if (isPng) return "image/png";
	const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
	if (isJpeg) return "image/jpeg";
	const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
	if (isGif) return "image/gif";
	const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57;
	if (isWebp) return "image/webp";
	return null;
}

export function isImageMime(mime: string): boolean {
	return mime.startsWith("image/");
}

type SavedUpload = { id: string; path: string; bytes: number; mime: string; name: string };

type SaveUploadInput = {
	/** 原始字节 */
	bytes: Uint8Array;
	/** 客户端声明的类型（仅用于非图片时的兜底） */
	declaredMime?: string;
	name?: string;
};

export function createUploadStore(options: { dataDir: string; now?: () => number; ttlMs?: number }) {
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;

	return {
		/** 保存一个上传；超限抛错（调用方转成 4xx） */
		async save(input: SaveUploadInput): Promise<SavedUpload> {
			if (input.bytes.byteLength === 0) throw new Error("空文件");
			if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
				throw new Error(`文件超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
			}
			const id = randomUUID().replace(/-/g, "").slice(0, 16);
			const mime = sniffMime(input.bytes) ?? (input.declaredMime || "application/octet-stream");
			const name = (input.name ?? "附件").slice(0, 200);
			const dir = uploadsDir(options.dataDir);
			await mkdir(dir, { recursive: true });
			/** 存盘名带原名：模型看到的提示词里就是**能读懂、带扩展名**的路径 */
			const path = join(dir, `${id}${safeNameSuffix(name)}`);
			await writeFile(path, input.bytes);
			// 顺手清理旧文件（不做后台任务，省一个定时器）
			await this.cleanup();
			return {
				id,
				path,
				bytes: input.bytes.byteLength,
				mime,
				name,
			};
		},

		/** 读回一个上传（校验 id 安全 + 文件存在） */
		async read(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
			const path = await storedPath(uploadsDir(options.dataDir), id);
			if (path === null) return null;
			try {
				const bytes = await readFile(path);
				return { bytes, mime: sniffMime(bytes) ?? "application/octet-stream" };
			} catch {
				return null;
			}
		},

		/**
		 * 上传副本的**绝对路径**（给提示词用，见 `session/attachment-resolve.ts`）。
		 *
		 * 以前没这个方法，于是 `resolveAttachments()` 回落成 `attachment.name` ——
		 * 模型收到的是「（附上文件，未注入内容：截图.png）」，一个没有目录的文件名，
		 * 根本读不到（用户 2026-11-26：「拖进来的文件，发送时没有发路径」）。
		 */
		async pathOf(id: string): Promise<string | null> {
			return storedPath(uploadsDir(options.dataDir), id);
		},

		/** 清理超过保留期的上传（返回删掉的数量） */
		async cleanup(): Promise<number> {
			const dir = uploadsDir(options.dataDir);
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return 0;
			}
			const deadline = now() - ttlMs;
			let removed = 0;
			for (const name of names) {
				try {
					const info = await stat(join(dir, name));
					if (info.mtimeMs < deadline) {
						await rm(join(dir, name), { force: true });
						removed += 1;
					}
				} catch {
					// 单个文件的问题不影响其他清理
				}
			}
			return removed;
		},
	};
}

export type UploadStore = ReturnType<typeof createUploadStore>;
