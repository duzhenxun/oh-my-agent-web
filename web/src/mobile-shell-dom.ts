/**
 * 「手机壳」判定的浏览器侧：把 `isMobileShell()` 的结果写到 <html class="is-mobile-shell">。
 *
 * 纯函数（UA 正则、宽度阈值）放在 mobile-shell.ts —— 那边不碰 DOM，可以直接引。
 */
import { isMobileShell } from "./mobile-shell.ts";

/** 当前浏览器是否该走单栏（没有 window 的环境一律 false） */
export function currentMobileShell(): boolean {
	if (typeof window === "undefined") return false;
	return isMobileShell({ width: window.innerWidth, userAgent: navigator.userAgent });
}

/** 把判定结果刷到 <html> 上（CSS 的唯一开关） */
function syncMobileShellClass(): void {
	document.documentElement.classList.toggle("is-mobile-shell", currentMobileShell());
}

/** 首帧前同步一次，并在窗口尺寸/方向变化时跟着刷；返回取消订阅函数 */
export function watchMobileShell(): () => void {
	syncMobileShellClass();
	const onChange = () => syncMobileShellClass();
	window.addEventListener("resize", onChange);
	window.addEventListener("orientationchange", onChange);
	return () => {
		window.removeEventListener("resize", onChange);
		window.removeEventListener("orientationchange", onChange);
	};
}
