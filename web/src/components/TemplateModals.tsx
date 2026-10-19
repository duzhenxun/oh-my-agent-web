import { useState } from "react";
import { setDraft } from "../store.ts";
import type { PromptTemplate } from "../types.ts";
import { setSettings, sendMessage } from "../ws.ts";

import { isBuiltin, removeTemplate, visibleTemplates } from "../templates-lib.ts";

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
	const insert = (template: PromptTemplate) => {
		setDraft(`${template.text}${template.text.endsWith("\n") ? "" : "\n"}`);
		onClose();
	};

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="提示词模板">
			<div className="modal tpl-modal">
				<div className="tpl-head">
					<strong className="tpl-title">提示词模板</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title="关闭">
						✕
					</button>
				</div>
				<div className="tpl-hint">点击卡片直接填入输入框，✏️ 可编辑或删除，也能新增自己的模板</div>
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
							<button type="button" className="tpl-edit" onClick={() => onEdit(template)} title="编辑">
								✏️
							</button>
						</div>
					))}
					<button type="button" className="tpl-card tpl-card-new" onClick={onCreate}>
						<span className="tpl-icon" aria-hidden="true">
							＋
						</span>
						<span className="tpl-name">新建模板</span>
						<span className="tpl-desc">把常用工作流存成模板</span>
					</button>
				</div>
				<div className="tpl-foot">
					{/* 传 null = 显式「恢复默认模板」（服务端专门处理这个手势） */}
					<button type="button" className="btn btn-tiny" onClick={() => setSettings({ templates: null })}>
						↺ 恢复默认模板
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
	onClose,
}: {
	template: PromptTemplate | null;
	/** 当前模板库（保存时在这个基础上改，不能凭空从空数组开始） */
	library: PromptTemplate[];
	onClose: () => void;
}) {
	const [name, setName] = useState(template?.name ?? "");
	const [description, setDescription] = useState(template?.description ?? "");
	const [text, setText] = useState(template?.text ?? "");
	const [error, setError] = useState<string | null>(null);

	// 当前库由父组件持有；保存时通过 onSaved 把它交回去（避免这里再读一次全局状态）
	const commit = (next: PromptTemplate[]) => {
		setSettings({ templates: next });
	};

	const save = (): PromptTemplate[] | null => {
		if (name.trim() === "" || text.trim() === "") {
			setError("标题和提示词都要填");
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
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="编辑提示词模板">
			<div className="modal tpl-editor">
				<div className="tpl-head">
					<span className="tpl-icon" aria-hidden="true">
						{template?.icon ?? "✳️"}
					</span>
					{template && isBuiltin(template) ? <span className="tpl-badge">内置</span> : null}
					<strong className="tpl-title">{template ? "编辑提示词模板" : "新建提示词模板"}</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title="关闭">
						✕
					</button>
				</div>

				<label className="tpl-field">
					<span className="tpl-label">标题</span>
					<input
						className="tpl-input"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="例：仓库初始化"
					/>
				</label>
				<label className="tpl-field">
					<span className="tpl-label">说明</span>
					<input
						className="tpl-input"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						placeholder="一句话：这个模板用来做什么"
					/>
				</label>
				<label className="tpl-field tpl-field-grow">
					<span className="tpl-label">提示词</span>
					<textarea
						className="tpl-textarea"
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder="写清楚要 agent 做什么、输出什么、不做什么"
					/>
				</label>
				{error ? <div className="tpl-error">{error}</div> : null}

				<div className="tpl-foot tpl-foot-editor">
					{template ? (
						<button
							type="button"
							className="btn btn-tiny btn-danger"
							title={isBuiltin(template) ? "内置模板只是隐藏，点「恢复默认模板」就能复原" : "自建模板会被彻底删除"}
							onClick={() => {
								commit(removeTemplate(library, template.id));
								onClose();
							}}
						>
							🗑 移出模板库{isBuiltin(template) ? "（可恢复）" : ""}
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
						保存修改
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => {
							const next = save();
							if (!next) return;
							commit(next);
							setDraft(`${text.trim()}\n`);
							onClose();
						}}
					>
						填入输入框
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-primary"
						onClick={() => {
							const next = save();
							if (!next) return;
							commit(next);
							sendMessage(text.trim());
							onClose();
						}}
					>
						➤ 直接发送
					</button>
				</div>
			</div>
		</div>
	);
}
