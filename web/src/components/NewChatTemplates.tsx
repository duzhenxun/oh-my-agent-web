import { useState } from "react";
import type { PromptTemplate } from "../types.ts";
import { localizeTemplate, visibleTemplates } from "../templates-lib.ts";
import { useLanguage, useT } from "../use-language.ts";
import { TemplateEditor } from "./TemplateModals.tsx";

/**
 * 新会话空白页的提示词列表：替换原来的招呼语。
 * 每张卡片就是一个模板，点击直接进入编辑；末尾一张「新建模板」。
 */
export function NewChatTemplates({
	templates,
	conversationId,
}: {
	templates: PromptTemplate[];
	conversationId?: string | null;
}) {
	const t = useT();
	// 内置模板存了两份（中文原文 + 英文副本）：界面是英文就画英文那份（见 templates-lib）
	const { language } = useLanguage();
	const [editing, setEditing] = useState<{ template: PromptTemplate | null } | null>(null);

	return (
		<>
			<div className="newchat-tpls" role="list" aria-label={t("提示词列表", "Prompt list")}>
				{visibleTemplates(templates).map((template) => {
					// 卡片上画的是**当前语言**那一份，但点进去编辑的仍是原始对象（编辑器自己再取一次）
					const shown = localizeTemplate(template, language);
					return (
						<button
							type="button"
							role="listitem"
							className="tpl-card newchat-tpl"
							key={template.id}
							onClick={() => setEditing({ template })}
							title={t("点击编辑", "Click to edit")}
						>
							<span className="tpl-icon" aria-hidden="true">
								{template.icon}
							</span>
							<span className="tpl-name">{shown.name}</span>
							<span className="tpl-desc">{shown.description}</span>
						</button>
					);
				})}
				<button
					type="button"
					role="listitem"
					className="tpl-card tpl-card-new newchat-tpl"
					onClick={() => setEditing({ template: null })}
				>
					<span className="tpl-icon" aria-hidden="true">
						＋
					</span>
					<span className="tpl-name">{t("新建模板", "New template")}</span>
					<span className="tpl-desc">{t("把常用工作流存成模板", "Save a repeated workflow as a template")}</span>
				</button>
			</div>
			{editing ? (
				<TemplateEditor
					template={editing.template}
					library={templates}
					conversationId={conversationId ?? null}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</>
	);
}
