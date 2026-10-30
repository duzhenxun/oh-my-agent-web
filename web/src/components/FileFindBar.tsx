/**
 * 代码预览底部那条「查找」工具条（Cmd/Ctrl+F 或右键「查找」唤出）。
 *
 * 为什么在**底部**：右栏是上下流的代码，底部离眼睛和手都近，也不挡正文第一行；
 * 弹在顶部会跟「源码 / 改动」那排按钮挤在一起。
 *
 * 键盘：输入框里 Enter = 下一个、Shift+Enter = 上一个、Esc = 关掉（全在输入框上处理，
 * 所以不用往 document 上挂全局监听）。
 */
import { useEffect, useRef } from "react";
import { useT } from "../use-language.ts";

export function FileFindBar({
	query,
	onQuery,
	total,
	index,
	onPrev,
	onNext,
	onClose,
}: {
	query: string;
	onQuery: (value: string) => void;
	/** 一共几处命中（0 = 没有 / 还没输入） */
	total: number;
	/** 当前是第几处（0-based） */
	index: number;
	onPrev: () => void;
	onNext: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement | null>(null);

	// 唤出来就把光标放进输入框：用户按 Cmd+F 的下一步一定是打字
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		input.select();
	}, []);

	const empty = query === "";
	return (
		<div className="file-find" role="search">
			<svg className="file-find-icon" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="7" cy="7" r="4.3" />
				<path d="m10.4 10.4 3.1 3.1" />
			</svg>
			<input
				ref={inputRef}
				className="file-find-input"
				value={query}
				placeholder={t("查找内容（Enter 下一个，Shift+Enter 上一个）", "Find (Enter next, Shift+Enter previous)")}
				onChange={(event) => onQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
						return;
					}
					if (event.key === "Enter") {
						event.preventDefault();
						if (total === 0) return;
						if (event.shiftKey) onPrev();
						else onNext();
					}
				}}
			/>
			<span className={`file-find-count${empty || total > 0 ? "" : " file-find-count-none"}`}>
				{empty ? "" : total === 0 ? t("无匹配", "No matches") : `${index + 1} / ${total}`}
			</span>
			<button
				type="button"
				className="file-find-btn"
				disabled={total === 0}
				title={t("上一个（Shift+Enter）", "Previous (Shift+Enter)")}
				aria-label={t("上一个", "Previous")}
				onClick={onPrev}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 12.4V3.8" />
					<path d="M4.2 7.2 8 3.6l3.8 3.6" />
				</svg>
			</button>
			<button
				type="button"
				className="file-find-btn"
				disabled={total === 0}
				title={t("下一个（Enter）", "Next (Enter)")}
				aria-label={t("下一个", "Next")}
				onClick={onNext}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 3.6v8.8" />
					<path d="M4.2 9.2 8 12.8l3.8-3.6" />
				</svg>
			</button>
			<button
				type="button"
				className="file-find-btn"
				title={t("关闭（Esc）", "Close (Esc)")}
				aria-label={t("关闭", "Close")}
				onClick={onClose}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="m4 4 8 8" />
					<path d="m12 4-8 8" />
				</svg>
			</button>
		</div>
	);
}
