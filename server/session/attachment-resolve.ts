/**
 * 附件解析（ADR-0020 §P3）——从 runtime 抽出（400 行护栏）。
 *
 * 把「消息里带的附件引用」翻译成引擎能用的东西：
 *   - 图片 → base64（交给引擎做**视觉注入**）；
 *   - 非图片 → **只把路径写进提示词**（ADR-0002 的原则：不注入内容）。
 *
 * 失效的附件（过期被清理）返回给调用方提示，而不是静默丢掉（ADR-0013：失败要可见）。
 */
import type { AttachmentRef } from "../protocol.js";

type UploadReader = {
	read: (id: string) => Promise<{ bytes: Buffer; mime: string } | null>;
	/** 副本在磁盘上的**绝对路径**（拿不到返回 null） */
	pathOf?: (id: string) => string | null | Promise<string | null>;
};

type ResolvedAttachments = {
	/** 追加过「路径引用」的提示词 */
	promptText: string;
	/** 图片（base64 + mime） */
	images: Array<{ data: string; mimeType: string }>;
	/** 失效的附件名（调用方负责提示） */
	missing: string[];
};

export async function resolveAttachments(
	text: string,
	attachments: AttachmentRef[] | undefined,
	uploadStore: UploadReader | undefined,
): Promise<ResolvedAttachments> {
	let promptText = text;
	const images: Array<{ data: string; mimeType: string }> = [];
	const missing: string[] = [];

	for (const attachment of attachments ?? []) {
		const found = uploadStore ? await uploadStore.read(attachment.id) : null;
		if (!found) {
			missing.push(attachment.name);
			continue;
		}
		if (attachment.kind === "image" && found.mime.startsWith("image/")) {
			images.push({ data: found.bytes.toString("base64"), mimeType: found.mime });
			continue;
		}
		const stored = uploadStore?.pathOf ? await uploadStore.pathOf(attachment.id) : null;
		if (stored !== null && stored !== "") {
			promptText += `\n\n（附上文件，未注入内容：${stored}）`;
			continue;
		}
		/**
		 * 没有路径就只能给文件名 —— 但要**把它说出来**，不要假装这是路径：
		 * 以前的实现直接拿 `attachment.name` 充路径，模型看到「（附上文件，未注入内容：截图.png）」
		 * 会当作相对路径去试，读不到就编（用户 2026-11-26：「发送时没有发路径」）。
		 */
		promptText += `\n\n（附上文件「${attachment.name}」，未注入内容；本环境只能给到文件名，没有磁盘路径）`;
	}

	if (promptText.trim() === "") promptText = "（见附件）";
	return { promptText, images, missing };
}
