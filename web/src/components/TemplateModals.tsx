import { useEffect, useState } from "react";
import { setDraft } from "../store.ts";
import type { PromptTemplate, QuickPhrase } from "../types.ts";
import { setSettings, generateTemplatePrompt } from "../ws.ts";

import { isBuiltin, localizePhrase, localizeTemplate, removeTemplate, visibleTemplates } from "../templates-lib.ts";
import { useLanguage, useT } from "../use-language.ts";

/**
 * 弹窗打开时按 Esc 关闭。
 *
 * 2026-11-23 用户：「这个弹窗点外面可以自动关闭，或是按 Esc 也能关闭」——
 * 以前这两个弹窗（模板库 / 模板编辑）只能点右上角那颗 ✕。
 *
 * 用**捕获阶段**监听：输入框里按 Esc 也要能关（有些控件会自己吞掉 keydown）；
 * `preventDefault` + `stopPropagation` 是为了别让同一颗 Esc 再被页面全局快捷键处理一次。
 */
function useEscapeToClose(onClose: () => void) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);
}

/** 模板库（P5）：卡片墙，点卡片直接填进输入框；铅笔进编辑；底部恢复默认。 */
export function TemplateGallery({
	templates,
	phrases,
	running = false,
	onQuickPhrase,
	onEdit,
	onCreate,
	onClose,
}: {
	templates: PromptTemplate[];
	/**
	 * 快捷指令（`settings.quickPhrases`）：2026-11-23 起**在这里改**，外面那颗「✏️ 编辑」撤掉了。
	 * 每条带两份（中文原文 + 英文副本），显示 / 发送时按界面语言取（见 `localizePhrase`）。
	 */
	phrases: QuickPhrase[];
	/** 有回合在跑：短语点了也不发（跟外面那排 chip 原来的守卫一致） */
	running?: boolean;
	/**
	 * 点弹窗里的快捷指令胶囊：`send` = 直接发出去，`fill` = 只填进输入框（Shift+点击）。
	 * 具体动作留在 `Composer` 那一层（它握着 `deliver` / 草稿 / 连点守卫）。
	 */
	onQuickPhrase?: (phrase: string, mode: "send" | "fill") => void;
	onEdit: (template: PromptTemplate) => void;
	onCreate: () => void;
	onClose: () => void;
}) {
	const t = useT();
	// 界面语言：决定卡片和短语胶囊画哪一份（内置项存了两份，见 templates-lib）
	const { language } = useLanguage();
	useEscapeToClose(onClose);
	/**
	 * 快捷指令：**一条一张卡片、带 × 删除，底部一个输入框 + 添加**（2026-11-23 用户：
	 * 「这个改成添加。输入框变小一点。添加上的上面有个 X 可以删除」）。
	 *
	 * 以前是一大块"一行一条"的 textarea：改一句要跑去找那一行、删一句要手动选掉整行。
	 * 现在改成"列表 + 添加"：每个胶囊自己带 ×，新增走下面那个小输入框；
	 * 每次增删**立刻** `set_settings`（不需要保存按钮，也没有防抖 —— 一次操作就一条改动）。
	 */
	const [newPhrase, setNewPhrase] = useState("");
	const addPhrase = () => {
		const value = newPhrase.trim();
		if (value === "") return;
		// 英文界面下加一条 = 中英两份都写这句（否则切到中文会变成另一种语言，见 QuickPhrase 的约定）
		const entry: QuickPhrase = language === "en" ? { text: value, textEn: value } : { text: value };
		setSettings({ quickPhrases: [...phrases, entry] });
		setNewPhrase("");
	};
	const removePhrase = (index: number) => {
		setSettings({ quickPhrases: phrases.filter((_, i) => i !== index) });
	};

	/** 有内容的条目（空字符串的脏数据不画、也不参与计数） */
	const visiblePhrases = phrases.filter((phrase) => (localizePhrase(phrase, language) ?? "").trim() !== "");
	const insert = (template: PromptTemplate) => {
		// 插进输入框的是**当前语言**那份正文（英文界面插英文提示词，不是只把标题翻掉）
		const { text } = localizeTemplate(template, language);
		setDraft(`${text}${text.endsWith("\n") ? "" : "\n"}`);
		onClose();
	};

	return (
		<div
			className="modal-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("提示词模板", "Prompt templates")}
			onClick={(event) => {
				// 点遮罩（不是弹窗内部）才关：内部点击冒泡上来时 target !== currentTarget
				if (event.target === event.currentTarget) onClose();
			}}
		>
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
					{visibleTemplates(templates).map((template) => {
						const shown = localizeTemplate(template, language);
						return (
							<div className="tpl-card" key={template.id}>
								<button
									type="button"
									className="tpl-card-main"
									onClick={() => insert(template)}
									title={shown.description || shown.name}
								>
									<span className="tpl-icon" aria-hidden="true">
										{template.icon}
									</span>
									<span className="tpl-name">{shown.name}</span>
									<span className="tpl-desc">{shown.description}</span>
								</button>
								<button type="button" className="tpl-edit" onClick={() => onEdit(template)} title={t("编辑", "Edit")}>
									✏️
								</button>
							</div>
						);
					})}
					<button type="button" className="tpl-card tpl-card-new" onClick={onCreate}>
						<span className="tpl-icon" aria-hidden="true">
							＋
						</span>
						<span className="tpl-name">{t("新建模板", "New template")}</span>
						<span className="tpl-desc">{t("把常用工作流存成模板", "Save a repeated workflow as a template")}</span>
					</button>
				</div>
				{/* ---- 快捷指令（以前是输入框上方那颗「✏️ 编辑」弹窗，2026-11-23 并进来）---- */}
				<div className="tpl-head tpl-head-sub">
					<strong className="tpl-title">{t("快捷指令", "Quick commands")}</strong>
					<span className="topbar-spacer" />
					{/* 没有「保存」按钮：改完自动存（防抖 400ms + 关窗补发一次） */}
					<span className="settings-sub">{t("改完自动保存", "Saved automatically")}</span>
				</div>
				{/*
				 * 每条 = 一颗可点的胶囊 + 一个 × 删除：
				 *   - 点名字：直接发出去（Shift+点击只填入输入框）；
				 *   - 点 ×：删掉这一条（立刻落库）。
				 */}
				{visiblePhrases.length > 0 ? (
					<div className="tpl-quick-chips">
						{phrases.map((phrase, index) => {
							const shownPhrase = localizePhrase(phrase, language);
							if (!shownPhrase) return null; // 脏数据（空条目）不画
							return (
								<span className="quick-chip tpl-quick-chip" key={phrase.text + index}>
									<button
										type="button"
										className="tpl-quick-send"
										disabled={running}
										title={t(
											`${shownPhrase}（点击直接发送 · Shift+点击只填入）`,
											`${shownPhrase} (click to send · Shift+click to fill in)`,
										)}
										onClick={(event) => {
											onQuickPhrase?.(shownPhrase, event.shiftKey ? "fill" : "send");
											onClose();
										}}
									>
										{shownPhrase}
									</button>
									<button
										type="button"
										className="tpl-quick-x"
										title={t("删除这条", "Delete this one")}
										aria-label={t("删除这条", "Delete this one")}
										onClick={() => removePhrase(index)}
									>
										×
									</button>
								</span>
							);
						})}
					</div>
				) : null}
				{/* 添加：一个小输入框 + 一颗按钮（回车也能加） */}
				<div className="tpl-quick-add">
					<input
						className="settings-input tpl-quick-input"
						value={newPhrase}
						placeholder={t("添加一条快捷指令…", "Add a quick command…")}
						maxLength={200}
						onChange={(event) => setNewPhrase(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							addPhrase();
						}}
					/>
					<button type="button" className="btn btn-tiny" onClick={addPhrase} disabled={newPhrase.trim() === ""}>
						{t("添加", "Add")}
					</button>
				</div>
				<div className="tpl-hint">
					{t(
						"最多 30 条、每条 200 字；增删立刻生效。点名字直接发送，Shift+点击只填入输入框。",
						"Up to 30 items, 200 characters each; changes apply immediately. Click to send, Shift+click to fill.",
					)}
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
	const { language } = useLanguage();
	useEscapeToClose(onClose);
	/**
	 * 三个输入框预填的是**当前语言**那份（内置模板存了两份，见 `localizeTemplate`）。
	 *
	 * 所以英文界面下改内置模板 = 英文那份成为这个模板的原文；之后服务端不会再给它补中文译文
	 * （规则只有一条：原文还等于内置原文才补第二份）。用户动了手，就以用户写的为准。
	 */
	const shownTemplate = template ? localizeTemplate(template, language) : null;
	const [name, setName] = useState(shownTemplate?.name ?? "");
	const [description, setDescription] = useState(shownTemplate?.description ?? "");
	const [text, setText] = useState(shownTemplate?.text ?? "");
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
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
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
