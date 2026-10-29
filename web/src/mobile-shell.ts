/**
 * 「手机壳」（单栏）判定。
 *
 * 命中任意一条就整站切单栏：**左边的侧栏是覆盖式抽屉**（只占 2/3 宽度，右侧露一截对话），
 * 对话在它下面单独一屏。
 *   1. **浏览器 UA 说是手机**（iPhone / Android Mobile / Windows Phone …）——
 *      手机横屏能到 900px，纯看宽度会把「手机」判成双栏，所以先看 UA；
 *   2. 宽度 ≤400px（桌面上把窗口拉得很窄时也一样切单栏）。
 *
 * 判定结果写在 `<html class="is-mobile-shell">` 上，CSS 只认这个类
 * （媒体查询做不到「UA 是手机但宽度 900」这种情况）。main.tsx 在首帧前就同步一次。
 */
const MOBILE_SHELL_MAX_WIDTH = 400;

/** 手机 UA：桌面浏览器一个都不匹配（iPad 的 UA 也带 Mobile，按手机处理没问题） */
const PHONE_UA = /iPhone|iPod|Android.*Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini|HarmonyOS|\bMobile\b/i;

function isPhoneUA(userAgent: string): boolean {
	return PHONE_UA.test(userAgent);
}

/** 纯函数：手机 UA 或窄屏 → 单栏 */
export function isMobileShell(input: { width: number; userAgent: string }): boolean {
	return input.width <= MOBILE_SHELL_MAX_WIDTH || isPhoneUA(input.userAgent);
}
