import { useEffect, useRef } from "react";
import { useT } from "../use-language.ts";

/**
 * 关闭临时对话的确认弹窗（自绘，复用 `.modal-backdrop` / `.modal` 的样式）。
 *
 * 默认焦点落在「取消」上：回车误按不会把内容丢掉；Esc / 点遮罩也是取消。
 */
export function CloseEphemeralDialog({
	title,
	onConfirm,
	onCancel,
}: {
	title: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const t = useT();
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);

	const name = title || t("未命名会话", "Untitled session");

	return (
		<div
			className="modal-backdrop"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="close-ephemeral-title"
			aria-describedby="close-ephemeral-desc"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onCancel();
			}}
		>
			<div className="modal">
				<h2 className="modal-title" id="close-ephemeral-title">
					{t(`关闭临时对话「${name}」？`, `Close the temporary chat “${name}”?`)}
				</h2>
				<div id="close-ephemeral-desc">
					<p className="modal-risk">
						{t(
							"它只活在内存里（没有会话文件），关闭后内容直接丢弃，无法恢复。",
							"It lives in memory only (there is no session file). Closing it discards the content for good.",
						)}
					</p>
					<p>
						{t(
							"想留下去历史里找，请先点「保存为正式对话」。",
							"To keep it in history, click “Save as a regular chat” first.",
						)}
					</p>
				</div>
				<div className="modal-actions">
					<button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
						{t("取消", "Cancel")}
					</button>
					<button type="button" className="btn btn-danger" onClick={onConfirm}>
						{t("关闭对话", "Close chat")}
					</button>
				</div>
			</div>
		</div>
	);
}
