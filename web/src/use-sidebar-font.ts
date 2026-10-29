import { useEffect, useState } from "react";
import {
	currentSidebarFonts,
	onSidebarFontChange,
	setSidebarProjectFont,
	setSidebarSessionFont,
	type SidebarFontState,
} from "./sidebar-font.ts";

/**
 * 侧栏字号（项目名 / 会话名）+ 改它们。
 *
 * 与 `use-chat-display.ts` 同一个模式：生效是**全局副作用**（改 `<html>` 上的 CSS 变量），
 * 所以状态靠事件同步 —— 谁调的 setter 都行，所有订阅者（设置面板的选中态）一起更新。
 */
export function useSidebarFonts(): SidebarFontState & {
	setProject: (id: SidebarFontState["project"]) => void;
	setSession: (id: SidebarFontState["session"]) => void;
} {
	const [state, setState] = useState<SidebarFontState>(currentSidebarFonts);
	useEffect(() => onSidebarFontChange(setState), []);
	return {
		...state,
		setProject: setSidebarProjectFont,
		setSession: setSidebarSessionFont,
	};
}
