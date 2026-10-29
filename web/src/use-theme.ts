import { useEffect, useState } from "react";
import { currentTheme, onThemeChange, setTheme, type ThemeDef, type ThemeId } from "./theme.ts";

/**
 * 当前主题 + 切主题。切换是**全局副作用**（改 `<html data-theme>`），所以状态靠事件同步：
 * 谁调的 `setTheme` 都行（设置面板、以后可能的快捷键），所有订阅者一起更新。
 */
export function useTheme(): { theme: ThemeDef; setTheme: (id: ThemeId) => void } {
	const [theme, setCurrent] = useState<ThemeDef>(() => currentTheme());
	useEffect(() => onThemeChange(setCurrent), []);
	return { theme, setTheme };
}
