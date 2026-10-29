/**
 * 附件上传（ADR-0020 §P3）：把「粘贴/拖入的文件」变成消息里的引用。
 *
 * 关键约束：**图片不塞 WS**（ADR-0004 单条 ≤64KB）→ 先 POST 到 `/api/uploads`，
 * 消息里只带 `AttachmentRef`（id + 元数据）。服务端再按 id 读回：图片做视觉注入，
 * 其它只把路径写进提示词。
 */
import type { AttachmentRef } from "./types.ts";

const MAX_ATTACHMENTS = 5;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 纯函数：从剪贴板/拖拽的文件列表里挑出可上传的（限数量与大小） */
export function pickUploadableFiles<T extends { name: string; size: number; type: string }>(
	files: T[],
	alreadyAttached: number,
): { accepted: T[]; rejected: string[] } {
	const accepted: T[] = [];
	const rejected: string[] = [];
	let count = alreadyAttached;

	for (const file of files) {
		if (count >= MAX_ATTACHMENTS) {
			rejected.push(`${file.name}：一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
			continue;
		}
		if (file.size === 0) {
			rejected.push(`${file.name}：空文件`);
			continue;
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			rejected.push(`${file.name}：超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
			continue;
		}
		accepted.push(file);
		count += 1;
	}
	return { accepted, rejected };
}

/** 纯函数：图片附件的 markdown 引用（写进消息正文，这样刷新后图片还在） */
export function imagesMarkdown(attachments: AttachmentRef[]): string {
	const lines = attachments
		.filter((attachment) => attachment.kind === "image")
		.map((attachment) => `![${attachment.name}](/api/uploads/${attachment.id})`);
	return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

type UploadResult = { ok: true; attachment: AttachmentRef } | { ok: false; error: string };

/** 上传一个文件（原始字节 + x-file-name 头；文件名走百分号编码，避免中文乱码） */
export async function uploadFile(file: {
	name: string;
	type: string;
	arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<UploadResult> {
	try {
		const response = await fetch("/api/uploads", {
			method: "POST",
			headers: {
				"content-type": file.type || "application/octet-stream",
				"x-file-name": encodeURIComponent(file.name),
			},
			body: await file.arrayBuffer(),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
			return { ok: false, error: body?.error?.message ?? `上传失败（HTTP ${response.status}）` };
		}
		return { ok: true, attachment: (await response.json()) as AttachmentRef };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
