import { useEffect, useState } from "react";
import {
	currentChatFont,
	currentChatWidth,
	onChatDisplayChange,
	setChatFont,
	setChatWidth,
	type ChatWidthId,
} from "./chat-display.ts";

/**
 * 聊天区字号 / 宽度 + 改它们。
 *
 * 与 `use-theme.ts` 同一个模式：生效是**全局副作用**（改 `<html>` 上的 CSS 变量），
 * 所以状态靠事件同步 —— 谁调的 setter 都行，所有订阅者一起更新。
 */
export function useChatDisplay(): {
	/** 正文字号（像素） */
	font: number;
	width: ChatWidthId;
	setFont: (px: number) => void;
	setWidth: (id: ChatWidthId) => void;
} {
	const [state, setState] = useState(() => ({ font: currentChatFont(), width: currentChatWidth() }));
	useEffect(() => onChatDisplayChange(setState), []);
	return { font: state.font, width: state.width, setFont: setChatFont, setWidth: setChatWidth };
}
