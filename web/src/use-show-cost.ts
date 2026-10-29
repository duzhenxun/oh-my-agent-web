import { currentMobileShell } from "./mobile-shell-dom.ts";
import { COST_KEY } from "./ui-prefs.ts";
import { useStoredBool } from "./use-stored-bool.ts";

/**
 * 「花费」($) 显不显示 —— 子代理卡片条 / 顶栏浮层 / 消息尾注共用这一份。
 *
 * 默认值**按设备给**：手机上默认不显示（一行本来就挤，金额又不像 token 那样能一眼估量），
 * 桌面上默认显示。偏好本身存本机 localStorage，所以手机和桌面各记各的；
 * 手机上想要也能在「设置 → 界面 → 用量」勾回来。
 *
 * 判定只在**第一次挂载**时取（`useStoredBool` 的初值），之后再怎么转屏 / 拉窗口都不改默认值 ——
 * 用户手动勾过的选择不该被一次旋转覆盖。
 */
export function showCostDefault(): boolean {
	return !currentMobileShell();
}

/** 只读：某个组件要不要画金额 */
export function useShowCost(): boolean {
	return useStoredBool(COST_KEY, showCostDefault())[0];
}
