import { APPBAR_ITEM_KEY, APPBAR_TOGGLES, type AppbarToggle } from "./ui-prefs.ts";
import { usePrefFlags } from "./use-pref-flags.ts";

/**
 * 顶栏入口（引擎切换 + 七个面板）的显隐 + 同步（设置里的勾选框和顶栏本身共用这一份）。
 *
 * 缺省全显示：老用户升级上来不该突然少了按钮。读写与跨标签页同步都在 `usePrefFlags` 里。
 */
export function useAppbarItems(): [Record<AppbarToggle, boolean>, (item: AppbarToggle, value: boolean) => void] {
	return usePrefFlags<AppbarToggle>(APPBAR_TOGGLES, APPBAR_ITEM_KEY);
}
