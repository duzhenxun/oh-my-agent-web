import { useEffect, useState } from "react";
import { currentChatFont, currentChatWidth, onChatDisplayChange, setChatFont, setChatWidth } from "./chat-display.ts";

/**
 * 聊天区字号 / 宽度 + 改它们。
 *
 * 与 `use-theme.ts` 同一个模式：生效是**全局副作用**（改 `<html>` 上的 CSS 变量），
 * 所以状态靠事件同步 —— 谁调的 setter 都行，所有订阅者一起更新。
 */
export function useChatDisplay(): {
	/** 正文字号（像素） */
	font: number;
	/** 对话列的最大宽度（像素；0 = 满宽） */
	width: number;
	setFont: (px: number) => void;
	setWidth: (px: number) => void;
} {
	const [state, setState] = useState(() => ({ font: currentChatFont(), width: currentChatWidth() }));
	useEffect(() => onChatDisplayChange(setState), []);
	return { font: state.font, width: state.width, setFont: setChatFont, setWidth: setChatWidth };
}
