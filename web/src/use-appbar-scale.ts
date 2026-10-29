import { useEffect, useState } from "react";
import { currentAppbarScale, onAppbarScaleChange, setAppbarScale } from "./appbar-scale.ts";

/**
 * 顶栏整体大小（设置 → 外观 → 顶栏高度）。
 *
 * 与 `use-sidebar-font.ts` 同一个模式：生效是**全局副作用**（改 `<html>` 上的
 * `--appbar-scale`），所以状态靠事件同步 —— 谁调的 setter 都行，
 * 所有订阅者（设置面板里的滑杆 / 快捷卡选中态）一起更新。
 */
export function useAppbarScale(): { percent: number; setPercent: (percent: number) => void } {
	const [percent, setState] = useState(currentAppbarScale);
	useEffect(() => onAppbarScaleChange(setState), []);
	return { percent, setPercent: setAppbarScale };
}
