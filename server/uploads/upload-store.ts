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

export const UPLOADS_DIR = "uploads";
/** 单文件上限（与 ADR-0020 §P3 一致） */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 单条消息附件上限 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** 上传文件保留期（默认 7 天） */
export const DEFAULT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ID_RE = /^[a-z0-9-]{8,64}$/;

export function uploadsDir(dataDir: string): string {
	return join(dataDir, UPLOADS_DIR);
}

/** 纯函数：id 是否安全（防 `../` 与绝对路径） */
export function isSafeUploadId(id: string): boolean {
	return ID_RE.test(id);
}

/** 纯函数：按魔术字节嗅探类型（不信任客户端给的 content-type） */
export function sniffMime(bytes: Uint8Array): string | null {
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

export type SavedUpload = { id: string; path: string; bytes: number; mime: string; name: string };

export type SaveUploadInput = {
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
			const dir = uploadsDir(options.dataDir);
			await mkdir(dir, { recursive: true });
			const path = join(dir, id);
			await writeFile(path, input.bytes);
			// 顺手清理旧文件（不做后台任务，省一个定时器）
			await this.cleanup();
			return {
				id,
				path,
				bytes: input.bytes.byteLength,
				mime,
				name: (input.name ?? "附件").slice(0, 200),
			};
		},

		/** 读回一个上传（校验 id 安全 + 文件存在） */
		async read(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
			if (!isSafeUploadId(id)) return null;
			try {
				const bytes = await readFile(join(uploadsDir(options.dataDir), id));
				return { bytes, mime: sniffMime(bytes) ?? "application/octet-stream" };
			} catch {
				return null;
			}
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
