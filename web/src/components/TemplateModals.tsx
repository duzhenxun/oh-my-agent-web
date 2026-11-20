import { useState } from "react";
import { setDraft } from "../store.ts";
import type { PromptTemplate } from "../types.ts";
import { setSettings, generateTemplatePrompt } from "../ws.ts";

import { isBuiltin, removeTemplate, visibleTemplates } from "../templates-lib.ts";
import { useT } from "../use-language.ts";

/** 模板库（P5）：卡片墙，点卡片直接填进输入框；铅笔进编辑；底部恢复默认。 */
export function TemplateGallery({
	templates,
	onEdit,
	onCreate,
	onClose,
}: {
	templates: PromptTemplate[];
	onEdit: (template: PromptTemplate) => void;
	onCreate: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const insert = (template: PromptTemplate) => {
		setDraft(`${template.text}${template.text.endsWith("\n") ? "" : "\n"}`);
		onClose();
	};

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("提示词模板", "Prompt templates")}>
			<div className="modal tpl-modal">
				<div className="tpl-head">
					<strong className="tpl-title">{t("提示词模板")}</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title={t("关闭", "Close")}>
						✕
					</button>
				</div>
				<div className="tpl-hint">{t("点击卡片直接填入输入框，✏️ 可编辑或删除，也能新增自己的模板")}</div>
				<div className="tpl-grid">
					{visibleTemplates(templates).map((template) => (
						<div className="tpl-card" key={template.id}>
							<button
								type="button"
								className="tpl-card-main"
								onClick={() => insert(template)}
								title={template.description || template.name}
							>
								<span className="tpl-icon" aria-hidden="true">
									{template.icon}
								</span>
								<span className="tpl-name">{template.name}</span>
								<span className="tpl-desc">{template.description}</span>
							</button>
							<button type="button" className="tpl-edit" onClick={() => onEdit(template)} title={t("编辑", "Edit")}>
								✏️
							</button>
						</div>
					))}
					<button type="button" className="tpl-card tpl-card-new" onClick={onCreate}>
						<span className="tpl-icon" aria-hidden="true">
							＋
						</span>
						<span className="tpl-name">{t("新建模板", "New template")}</span>
						<span className="tpl-desc">{t("把常用工作流存成模板", "Save a repeated workflow as a template")}</span>
					</button>
				</div>
				<div className="tpl-foot">
					{/* 传 null = 显式「恢复默认模板」（服务端专门处理这个手势） */}
					<button type="button" className="btn btn-tiny" onClick={() => setSettings({ templates: null })}>
						↺ {t("恢复默认模板", "Restore the default templates")}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 模板编辑弹窗（P5）：标题 / 说明 / 提示词 三段 + 四个动作。
 * `template === null` 表示新建。内置模板不能「移出模板库」（那是永久删除默认项）。
 */
export function TemplateEditor({
	template,
	library,
	conversationId,
	onClose,
}: {
	template: PromptTemplate | null;
	/** 当前模板库（保存时在这个基础上改，不能凭空从空数组开始） */
	library: PromptTemplate[];
	/** 当前会话：AI 生成时优先用它正在用的模型（没有会话就自动挑一个可用的） */
	conversationId?: string | null;
	onClose: () => void;
}) {
	const t = useT();
	const [name, setName] = useState(template?.name ?? "");
	const [description, setDescription] = useState(template?.description ?? "");
	const [text, setText] = useState(template?.text ?? "");
	const [error, setError] = useState<string | null>(null);
	const [generating, setGenerating] = useState(false);
	/** AI 覆盖正文前的原文；用户手动再改正文后即清空（那时撤销会吃掉他的改动） */
	const [previous, setPrevious] = useState<string | null>(null);

	const generate = async () => {
		setError(null);
		setGenerating(true);
		const result = await generateTemplatePrompt({ name, description, text, conversationId: conversationId ?? null });
		setGenerating(false);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		setPrevious(text);
		setText(result.text);
	};

	const undoGenerate = () => {
		if (previous !== null) setText(previous);
		setPrevious(null);
	};

	// 当前库由父组件持有；保存时通过 onSaved 把它交回去（避免这里再读一次全局状态）
	const commit = (next: PromptTemplate[]) => {
		setSettings({ templates: next });
	};

	const save = (): PromptTemplate[] | null => {
		if (name.trim() === "" || text.trim() === "") {
			setError(t("标题和提示词都要填", "Both the title and the prompt are required"));
			return null;
		}
		const draft: PromptTemplate = {
			id: template?.id ?? `tpl-${Date.now().toString(36)}`,
			name: name.trim(),
			description: description.trim(),
			icon: template?.icon ?? "✳️",
			text: text.trim(),
		};
		const next = template ? library.map((item) => (item.id === template.id ? draft : item)) : [...library, draft];
		return next;
	};

	return (
		<div
			className="modal-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("编辑提示词模板", "Edit a prompt template")}
		>
			<div className="modal tpl-editor">
				<div className="tpl-head">
					<span className="tpl-icon" aria-hidden="true">
						{template?.icon ?? "✳️"}
					</span>
					{template && isBuiltin(template) ? <span className="tpl-badge">{t("内置", "Built-in")}</span> : null}
					<strong className="tpl-title">
						{template ? t("编辑提示词模板", "Edit a prompt template") : t("新建提示词模板", "New prompt template")}
					</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title={t("关闭", "Close")}>
						✕
					</button>
				</div>

				<label className="tpl-field">
					<span className="tpl-label">{t("标题", "Title")}</span>
					<input
						className="tpl-input"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={t("例：仓库初始化", "e.g. bootstrapping a repo")}
					/>
				</label>
				<label className="tpl-field">
					<span className="tpl-label">{t("说明", "Description")}</span>
					<input
						className="tpl-input"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						placeholder={t("一句话：这个模板用来做什么", "One line: what this template is for")}
					/>
				</label>
				<div className="tpl-field tpl-field-grow">
					<div className="tpl-label-row">
						<label className="tpl-label" htmlFor="tpl-prompt-text">
							{t("提示词", "Prompt")}
						</label>
						<span className="topbar-spacer" />
						{previous !== null ? (
							<button type="button" className="btn btn-tiny" onClick={undoGenerate}>
								↶ {t("撤销", "Undo")}
							</button>
						) : null}
						<button
							type="button"
							className="btn btn-tiny"
							disabled={generating}
							onClick={() => void generate()}
							title={t(
								"根据标题、说明和已有草稿，写一份标准提示词（会覆盖当前正文，可撤销）",
								"Write a standard prompt from the title, description and draft (replaces the prompt; undo available)",
							)}
						>
							✨ {generating ? t("生成中…", "Generating…") : t("AI 生成", "Generate with AI")}
						</button>
					</div>
					<textarea
						id="tpl-prompt-text"
						className="tpl-textarea"
						value={text}
						onChange={(event) => {
							setText(event.target.value);
							setPrevious(null);
						}}
						placeholder={t(
							"写清楚要 agent 做什么、输出什么、不做什么",
							"Be explicit about what the agent should do, output, and not do",
						)}
					/>
				</div>
				{error ? <div className="tpl-error">{error}</div> : null}

				<div className="tpl-foot tpl-foot-editor">
					{template ? (
						<button
							type="button"
							className="btn btn-tiny btn-danger"
							title={
								isBuiltin(template)
									? t(
											"内置模板只是隐藏，点「恢复默认模板」就能复原",
											"A built-in template is only hidden; use “Restore the default templates” to bring it back",
										)
									: t("自建模板会被彻底删除", "A template you created is deleted permanently")
							}
							onClick={() => {
								commit(removeTemplate(library, template.id));
								onClose();
							}}
						>
							🗑 {t("移出模板库", "Remove from library")}
							{isBuiltin(template) ? t("（可恢复）", " (recoverable)") : ""}
						</button>
					) : null}
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => {
							const next = save();
							if (!next) return;
							commit(next);
							onClose();
						}}
					>
						{t("保存修改", "Save changes")}
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-primary"
						onClick={() => {
							const next = save();
							if (!next) return;
							commit(next);
							setDraft(`${text.trim()}\n`);
							onClose();
						}}
					>
						{t("填入输入框", "Fill the input")}
					</button>
				</div>
			</div>
		</div>
	);
}
