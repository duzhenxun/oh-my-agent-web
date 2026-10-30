import { APPBAR_ITEM_KEY, APPBAR_TOGGLES, appbarItemDefault, type AppbarToggle } from "./ui-prefs.ts";
import { usePrefFlags } from "./use-pref-flags.ts";

/**
 * 顶栏入口（七个面板）的显隐 + 同步（设置里的勾选框和顶栏本身共用这一份）。
 *
 * 默认只勾模型 / 技能 / 语音 / MCP（见 `APPBAR_ITEM_DEFAULT_ON`）：新装完不该一上来就铺满一排按钮，
 * 推送 / 插件 / 子代理想用的人在设置里勾。本地存过的值仍然优先 —— 老用户不会被这条例改回原样。
 */
export function useAppbarItems(): [Record<AppbarToggle, boolean>, (item: AppbarToggle, value: boolean) => void] {
	return usePrefFlags<AppbarToggle>(APPBAR_TOGGLES, APPBAR_ITEM_KEY, appbarItemDefault);
}
