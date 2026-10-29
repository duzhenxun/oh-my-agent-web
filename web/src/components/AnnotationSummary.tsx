import { useEffect, useRef, useState } from "react";
import { useT } from "../use-language.ts";
import { annotationNumber, type Annotation } from "../annotations.ts";

/**
 * 输入框**里面**那颗「N 条注释」的小胶囊（点开才是完整列表）。
 *
 * 为什么收起来：标注多了以后，一条条摊在对话里比引文还吵 ——
 * 正文里已经有一个编号在对应位置了，这里默认只回答「这条对话被我标了几处」。
 * 点开才逐条列出：编号 + 那句原文（一行）+ 我自己的评论，外加三个动作
 * （「评论」= 就地写/改这一条的评论；「放进输入框」= 把这段和评论一起变成引用接进草稿；
 * 「✕」= 删掉这条标注）。
 *
 * 位置：它由 App 塞进 `Composer` 里（`.composer` 的**边框之内**）——
 * 以前挂在输入框外面单独一行，看着像另一样东西；它本来就是「这条会话待发的内容」，
 * 待在正在打字的那个框里才对得上。
 *
 * 评论为什么在这儿写：选中文字那颗「添加到会话」一点就落定（不再弹一个小输入框拦一道）。
 * 想补一句就点开列表就地写，写完回车即可 —— 草稿里的字一个都不动。
 */
export function AnnotationSummary({
	annotations,
	open,
	focusedId,
	onToggle,
	onRemove,
	onQuote,
	onJump,
	onComment,
}: {
	annotations: readonly Annotation[];
	open: boolean;
	/** 刚从正文里点过来的那条：列表里给它高亮一下，让人知道点的是哪一条 */
	focusedId?: string | null;
	onToggle: () => void;
	onRemove: (id: string) => void;
	onQuote: (item: Annotation) => void;
	onJump: (item: Annotation) => void;
	/** 写/改一条的评论（空串 = 清掉评论） */
	onComment: (id: string, comment: string) => void;
}) {
	const t = useT();
	/** 正在就地编辑哪一条的评论 */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (editingId !== null) inputRef.current?.focus();
	}, [editingId]);

	// 收起整个列表 / 这一条被删掉：别留着一个指向不存在行的编辑框
	useEffect(() => {
		if (!open) setEditingId(null);
		else if (editingId !== null && !annotations.some((item) => item.id === editingId)) setEditingId(null);
	}, [open, annotations, editingId]);

	if (annotations.length === 0) return null;

	const startEditing = (item: Annotation) => {
		setEditingId(item.id);
		setDraft(item.comment);
	};
	const commitEditing = () => {
		if (editingId !== null) onComment(editingId, draft.trim());
		setEditingId(null);
	};

	return (
		<div className="annot-summary">
			<button
				type="button"
				className="annot-chip"
				onClick={onToggle}
				aria-expanded={open}
				title={t("这条对话里标过的几处文字（点开看每一条）", "Spots you marked in this chat (click to see each)")}
			>
				<span className="annot-chip-icon" aria-hidden="true">
					{/* 一颗小气泡：这是「注释」，不是菜单（以前那个 ☰ 看着像汉堡菜单） */}
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
						<path d="M2.5 3.5h11v7.2h-6L4.2 13v-2.3H2.5z" strokeLinejoin="round" />
					</svg>
				</span>
				{t(`${annotations.length} 条注释`, `${annotations.length} note(s)`)}
				<span className={`annot-chip-caret${open ? " annot-chip-caret-open" : ""}`} aria-hidden="true" />
			</button>
			{open ? (
				<ul className="annot-list">
					{annotations.map((item) => {
						const excerpt = item.anchor.exact.replace(/\s+/g, " ").trim();
						const editing = editingId === item.id;
						return (
							<li
								key={item.id}
								id={`annot-row-${item.id}`}
								className={`annot-row${focusedId === item.id ? " annot-row-focus" : ""}`}
							>
								<button
									type="button"
									className="annot-row-main"
									onClick={() => onJump(item)}
									title={t("跳到正文里那一处", "Jump to that spot in the chat")}
								>
									<span className="annot-index">{annotationNumber(annotations, item.id)}</span>
									<span className="annot-excerpt">{excerpt}</span>
								</button>
								{editing ? (
									<div className="annot-edit">
										<input
											ref={inputRef}
											className="annot-edit-input"
											value={draft}
											onChange={(event) => setDraft(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter" && !event.shiftKey) {
													event.preventDefault();
													commitEditing();
												}
												if (event.key === "Escape") {
													event.preventDefault();
													setEditingId(null);
												}
											}}
											placeholder={t(
												"给这一处写句评论（可留空，回车保存）",
												"Comment on this spot (optional, Enter to save)",
											)}
											aria-label={t("这条标注的评论", "Comment for this note")}
										/>
										<button
											type="button"
											className="annot-action annot-action-ok"
											onClick={commitEditing}
											title={t("保存评论", "Save comment")}
										>
											✓
										</button>
									</div>
								) : item.comment !== "" ? (
									<button
										type="button"
										className="annot-comment"
										onClick={() => startEditing(item)}
										title={t("点一下改这句评论", "Click to edit this comment")}
									>
										{item.comment}
									</button>
								) : null}
								<div className="annot-row-actions">
									{editing ? null : (
										<button
											type="button"
											className="annot-action"
											onClick={() => startEditing(item)}
											title={t(
												item.comment === "" ? "给这一处写句评论" : "改这一处的评论",
												item.comment === "" ? "Comment on this spot" : "Edit this comment",
											)}
										>
											{item.comment === "" ? t("＋ 评论", "+ Comment") : t("改评论", "Edit")}
										</button>
									)}
									<button
										type="button"
										className="annot-action"
										onClick={() => onQuote(item)}
										title={t(
											"把这段（连同评论）变成引用接进输入框，再写自己的问题发出去",
											"Quote this (with your comment) into the input, then send",
										)}
									>
										{t("放进输入框", "Quote it")}
									</button>
									<button
										type="button"
										className="annot-action annot-action-remove"
										onClick={() => onRemove(item.id)}
										title={t("删掉这条标注", "Remove this annotation")}
										aria-label={t("删掉这条标注", "Remove this annotation")}
									>
										✕
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}
