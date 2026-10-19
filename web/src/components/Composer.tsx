import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { imagesMarkdown, pickUploadableFiles, uploadFile } from "../attachments.ts";
import { TemplateEditor, TemplateGallery } from "./TemplateModals.tsx";
import { setDraft, useAppState } from "../store.ts";
import type { AttachmentRef, PromptTemplate } from "../types.ts";
import { interrupt, sendMessage, setModel } from "../ws.ts";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 输入区：快捷短语行（ADR-0020 §P1）+ 待发附件（ADR-0020 §P3）+ 多行输入框。
 *
 * 粘贴截图：剪贴板里的图片直接上传（不塞 WS），显示成待发 chip；
 * 发送时把 `AttachmentRef` 交给服务端（图片做视觉注入），并把 markdown 图片引用写进正文，
 * 这样**刷新之后图片仍然显示**（引用随会话文件落盘）。
 */
export function Composer({ running, conversationId }: { running: boolean; conversationId: string | null }) {
	const { draft, snapshot } = useAppState();
	const [pending, setPending] = useState<AttachmentRef[]>([]);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const quickPhrases = snapshot?.settings.quickPhrasesEnabled ? (snapshot?.settings.quickPhrases ?? []) : [];
	const templates = snapshot?.settings.templates ?? [];
	// 模板库 / 模板编辑两个弹窗（P5）
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [editing, setEditing] = useState<{ template: PromptTemplate | null } | null>(null);

	const addFiles = async (files: File[]) => {
		if (files.length === 0) return;
		const { accepted, rejected } = pickUploadableFiles(files, pending.length);
		if (rejected.length > 0) setUploadError(rejected.join("；"));
		if (accepted.length === 0) return;

		setUploading(true);
		const uploaded: AttachmentRef[] = [];
		for (const file of accepted) {
			const result = await uploadFile(file);
			if (result.ok) uploaded.push(result.attachment);
			else setUploadError(result.error);
		}
		setUploading(false);
		if (uploaded.length > 0) {
			setPending((current) => [...current, ...uploaded].slice(0, 5));
			setUploadError(null);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		// 只看图片：纯文本粘贴交回给浏览器默认行为
		const files = [...event.clipboardData.items]
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	};

	const submit = () => {
		const value = draft.trim();
		if ((!value && pending.length === 0) || running) return;
		// 图片引用写进正文（刷新后仍显示）；附件本体走 references
		sendMessage(value + imagesMarkdown(pending), pending.length > 0 ? pending : undefined);
		setDraft("");
		setPending([]);
		setUploadError(null);
	};

	return (
		<div className="composer-wrap">
			{quickPhrases.length > 0 ? (
				<div className="quick-row">
					{quickPhrases.map((phrase) => (
						<button
							type="button"
							key={phrase}
							className="quick-chip"
							disabled={running}
							title={`${phrase}（点击直接发送 · Shift+点击只填入）`}
							onClick={(event) => {
								if (event.shiftKey) {
									setDraft(phrase);
									inputRef.current?.focus();
									return;
								}
								if (running) return;
								sendMessage(phrase);
							}}
						>
							{phrase}
						</button>
					))}
				</div>
			) : null}

			{pending.length > 0 || uploading || uploadError ? (
				<div className="attach-row">
					{pending.map((attachment) => (
						<span className="attach-chip" key={attachment.id} title={`${attachment.mime} · ${attachment.name}`}>
							{attachment.kind === "image" ? (
								<img className="attach-thumb" src={`/api/uploads/${attachment.id}`} alt={attachment.name} />
							) : (
								<span className="attach-kind">📄</span>
							)}
							<span className="attach-name">{attachment.name}</span>
							<span className="attach-size">{formatBytes(attachment.bytes)}</span>
							<button
								type="button"
								className="attach-remove"
								title="移除"
								onClick={() => setPending((current) => current.filter((item) => item.id !== attachment.id))}
							>
								×
							</button>
						</span>
					))}
					{uploading ? <span className="attach-hint">上传中…</span> : null}
					{uploadError ? <span className="attach-error">{uploadError}</span> : null}
				</div>
			) : null}

			<div className="composer">
				<textarea
					ref={inputRef}
					className="composer-input"
					value={draft}
					placeholder={
						running ? "正在跑…（回车排队会被拒绝，先点停止）" : "说点什么，回车发送 · Shift+回车换行 · 可直接粘贴截图"
					}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={onPaste}
					onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						submit();
					}}
					rows={3}
				/>
				<div className="composer-actions">
					{running ? (
						<button type="button" className="btn btn-stop" onClick={() => conversationId && interrupt(conversationId)}>
							停止
						</button>
					) : (
						<button
							type="button"
							className="btn btn-send"
							onClick={submit}
							disabled={draft.trim().length === 0 && pending.length === 0}
						>
							➤ 发送
						</button>
					)}
				</div>
			</div>

			{/* 输入框下面一行：模板 → 模型（对齐参考实现的排布；右侧留出思考强度/工具范围的位置） */}
			<div className="composer-tools">
				<button type="button" className="tool-chip" onClick={() => setGalleryOpen(true)} title="提示词模板库">
					🧩 模板
				</button>
				<span className="tool-sep" aria-hidden="true" />
				{snapshot?.model || snapshot?.models.length || conversationId ? (
					<span className="tool-group" title="这个会话使用的模型">
						<span className="tool-icon" aria-hidden="true">
							🤖
						</span>
						{snapshot && snapshot.models.length > 0 && snapshot.engineCapabilities.modelSwitch ? (
							<select
								className="tool-chip tool-select mono"
								value={snapshot.model ?? ""}
								onChange={(event) => setModel(event.target.value)}
							>
								{snapshot.model && !snapshot.models.some((model) => model.id === snapshot.model) ? (
									<option value={snapshot.model}>{snapshot.model}</option>
								) : null}
								{snapshot.models.map((model) => (
									<option key={model.id} value={model.id}>
										{model.label}
									</option>
								))}
							</select>
						) : (
							<span className="tool-chip tool-static mono">{snapshot?.model ?? "模型未就绪"}</span>
						)}
					</span>
				) : null}
				{/* 右侧扩展位：思考强度 / 工具范围 / 压缩（P4 待做，先占位保持排布稳定） */}
				<span className="topbar-spacer" />
			</div>

			{galleryOpen ? (
				<TemplateGallery
					templates={templates}
					onEdit={(template) => setEditing({ template })}
					onCreate={() => setEditing({ template: null })}
					onClose={() => setGalleryOpen(false)}
				/>
			) : null}
			{editing ? (
				<TemplateEditor template={editing.template} library={templates} onClose={() => setEditing(null)} />
			) : null}
		</div>
	);
}
