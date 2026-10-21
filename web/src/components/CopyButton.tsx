/**
 * 「⧉ 复制」按钮：点完给一次可见的反馈（✓ 已复制，1.4 秒后自己变回来）。
 *
 * 之前各处都是 `onClick={() => navigator.clipboard.writeText(text)}`：
 * 点完界面**一点变化都没有**，用户只能靠「到底复制没复制」去猜。
 *
 * 两个细节：
 *   - 剪贴板 API 在非 https / 无权限时会失败 → 退回 textarea + execCommand；
 *   - 卸载时清掉定时器（消息列表会随会话切换整体重渲染）。
 */
import { useEffect, useRef, useState } from "react";

const RESET_MS = 1400;

export function CopyButton({
	text,
	className = "msg-action",
	title = "复制",
}: {
	/** 要复制的文本 */
	text: string;
	/** 外观类名（标题行的 .msg-action / 页脚的 .msg-foot-copy） */
	className?: string;
	title?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = async () => {
		try {
			await navigator.clipboard?.writeText(text);
		} catch {
			// 老浏览器 / 没权限（http、iframe）：用隐藏 textarea 兜底
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			try {
				document.execCommand("copy");
			} catch {
				// 实在复制不了也不装成功：按钮不变
				area.remove();
				return;
			}
			area.remove();
		}
		setCopied(true);
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(false), RESET_MS);
	};

	return (
		<button
			type="button"
			className={`${className}${copied ? " is-copied" : ""}`}
			title={copied ? "已复制到剪贴板" : title}
			aria-live="polite"
			onClick={() => void copy()}
		>
			{copied ? "✓ 已复制" : "⧉ 复制"}
		</button>
	);
}
