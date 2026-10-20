import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { imagesMarkdown, pickUploadableFiles, uploadFile } from "../attachments.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";
import { TemplateEditor, TemplateGallery } from "./TemplateModals.tsx";
import { setDraft, useAppState } from "../store.ts";
import type { AttachmentRef, PromptTemplate } from "../types.ts";
import { interrupt, sendMessage, setApprovalMode } from "../ws.ts";

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

	const submit = (mode: "now" | "queue" | "steer" = "now") => {
		const value = draft.trim();
		if (!value && pending.length === 0) return;
		if (running && mode === "now") return;
		// 图片引用写进正文（刷新后仍显示）；附件本体走 references
		sendMessage(value + imagesMarkdown(pending), pending.length > 0 ? pending : undefined, mode);
		setDraft("");
		if (inputRef.current) inputRef.current.style.height = "auto";
		setPending([]);
		setUploadError(null);
	};

	return (
		<div className="composer-wrap">
			<div className="composer-topbar">
				{/* 输入框上方一行：模板 / 模型 / 强度 / 审批 + 快捷短语（同一行） */}
				<div className="composer-tools">
					<button
						type="button"
						className="tool-chip composer-template-btn"
						onClick={() => setGalleryOpen(true)}
						title="提示词模板库"
					>
						🧩 模板
					</button>
					<span className="tool-sep" aria-hidden="true" />
					{/* 模型槽位**永远在**：列表没到 / 引擎暂时取不到时显示占位，
				    免得用户以为功能坏了（"怎么又不见了" 就是清空列表造成的） */}
					{snapshot && snapshot.models.length > 0 && snapshot.engineCapabilities.modelSwitch ? (
						<ModelPicker models={snapshot.models} current={snapshot.model} />
					) : (
						<span
							className="tool-chip tool-static mono"
							title={snapshot?.model ? "这个会话使用的模型" : "还没打开会话，模型列表要等会话就绪"}
						>
							<span className="tool-icon" aria-hidden="true">
								🤖
							</span>
							<span>{snapshot?.model ?? "模型未就绪"}</span>
						</span>
					)}
					<ThinkingPicker level={snapshot?.thinkingLevel ?? null} levels={snapshot?.thinkingLevels ?? []} />
					<span className="tool-sep" aria-hidden="true" />
					{snapshot?.engineCapabilities.approvals === false ? (
						<span className="tool-chip tool-static" title="该引擎自行决定授权，本工作台拦不住它的危险操作">
							🔒 审批：引擎自理
						</span>
					) : (
						<button
							type="button"
							className={`tool-chip composer-approval-btn${snapshot?.approvalMode === "allow" ? " tool-chip-warn" : ""}`}
							onClick={() => setApprovalMode(snapshot?.approvalMode === "allow" ? "ask" : "allow")}
							title="审批模式（只在本会话生效，重启恢复询问）"
						>
							{snapshot?.approvalMode === "allow" ? "🔓 审批：全部放行" : "🔒 审批：询问"}
						</button>
					)}
					{/* 右侧扩展位：工具范围 / 压缩（P4 待做，先占位保持排布稳定） */}
					<span className="topbar-spacer" />
				</div>
				<span className="tool-sep" aria-hidden="true" />

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
			</div>

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
					placeholder={running ? "正在跑…（回车排队会被拒绝，先点停止）" : "说点什么，回车发送 · Shift+回车换行"}
					onChange={(event) => {
						setDraft(event.target.value);
						// 自动高度：先归零再按内容算，上限 240px（超过就内部滚动）
						const element = event.currentTarget;
						element.style.height = "auto";
						element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
					}}
					onPaste={onPaste}
					onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						// 回车默认：空闲时直接发；回合进行中默认「引导」（排队要点按钮）
						submit(running ? "steer" : "now");
					}}
					rows={1}
				/>
				<div className="composer-actions">
					{running && draft.trim() !== "" ? (
						<>
							<button
								type="button"
								className="btn btn-send"
								title="插进当前这一轮（打断它，按新指示继续）"
								onClick={() => submit("steer")}
							>
								引导
							</button>
							<button
								type="button"
								className="btn btn-queue"
								title="等这一轮结束后再发"
								onClick={() => submit("queue")}
							>
								排队
							</button>
							<button
								type="button"
								className="btn btn-stop"
								onClick={() => conversationId && interrupt(conversationId)}
							>
								停止
							</button>
						</>
					) : running ? (
						<button type="button" className="btn btn-stop" onClick={() => conversationId && interrupt(conversationId)}>
							停止
						</button>
					) : (
						<button
							type="button"
							className="btn btn-send"
							onClick={() => submit("now")}
							disabled={draft.trim().length === 0 && pending.length === 0}
						>
							➤ 发送
						</button>
					)}
				</div>
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
