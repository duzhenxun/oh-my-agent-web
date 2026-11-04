import { useState } from "react";
import { setSettings } from "../ws.ts";
import { useT } from "../use-language.ts";

/**
 * 快捷指令编辑弹窗（输入框上方那一排胶囊的单独编辑入口）。
 *
 * 内容和设置面板「快捷短语」是同一份数据（服务端 `settings.quickPhrases`，多设备一致），
 * 只是这里给一个就近的入口：不想为了改一句话去翻设置。
 * 一行一条；保存后为空数组时，输入框上方整排（含分隔线）会自动收掉。
 */
export function QuickPhraseEditor({ phrases, onClose }: { phrases: string[]; onClose: () => void }) {
	const t = useT();
	const [text, setText] = useState(() => phrases.join("\n"));

	const save = () => {
		// 和设置面板保持一致：按行切分，空行丢掉（否则会渲染出一颗空白胶囊）
		const next = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		setSettings({ quickPhrases: next });
		onClose();
	};

	return (
		<div
			className="modal-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("编辑快捷指令", "Edit quick commands")}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="modal quick-edit-modal">
				<div className="tpl-head">
					<strong className="tpl-title">{t("编辑快捷指令", "Edit quick commands")}</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title={t("关闭", "Close")}>
						✕
					</button>
				</div>
				<div className="tpl-hint">
					{t(
						"一行一条，保存后立刻生效；点胶囊直接发送，Shift+点击只填入输入框。留空则不显示这一排。",
						"One per line. Saved instantly; click a chip to send, Shift+click to fill the input. Leave empty to hide the row.",
					)}
				</div>
				<textarea
					className="quick-edit-text"
					value={text}
					rows={8}
					spellCheck={false}
					autoFocus
					placeholder={t("继续\n发布灰度", "Continue\nDeploy to gray")}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							save();
						}
						if (event.key === "Escape") onClose();
					}}
				/>
				<div className="tpl-foot">
					<button type="button" className="btn btn-tiny" onClick={onClose}>
						{t("取消", "Cancel")}
					</button>
					<button type="button" className="btn btn-tiny btn-primary" onClick={save}>
						{t("保存", "Save")}
					</button>
				</div>
			</div>
		</div>
	);
}
