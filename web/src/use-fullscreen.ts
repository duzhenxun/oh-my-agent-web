import { useCallback, useEffect, useState } from "react";

/**
 * 整页全屏（`document.documentElement` 那一套 Fullscreen API）。
 *
 * 现状（2026-10-28）：**没有入口**了 —— 顶栏那颗「全屏」按钮用户要求先撤掉
 * （见 App.tsx 里 appbar-side 的那段注释）。这个 hook 是完整可用的实现，
 * 想放回来只需在 App 里 `const fullscreen = useDocumentFullscreen()` 再画一颗按钮。
 *
 * 为什么不用 F11：F11 是浏览器自己的全屏，网页拿不到状态（也没法从 UI 里退出），
 * 而顶栏这颗按钮要能「点一下进、再点一下出」，所以走 `requestFullscreen()`，
 * 状态只认 `document.fullscreenElement`（用户按 Esc / 用浏览器自带方式退出时也要跟着变）。
 *
 * `supported` 为 false 时不渲染按钮：iOS Safari 不支持元素全屏（只支持 video 全屏），
 * 与其点了没反应，不如不画。
 */
export function useDocumentFullscreen(): { supported: boolean; active: boolean; toggle: () => void } {
	// SSR / 极端环境下 document 可能没有；这里一律降级成「不支持」
	const supported = typeof document !== "undefined" && document.fullscreenEnabled === true;
	const [active, setActive] = useState(() => typeof document !== "undefined" && document.fullscreenElement !== null);

	useEffect(() => {
		// 进出全屏都会触发（含 Esc 退出），统一以浏览器为准，不在本地维护第二份状态
		const onChange = () => setActive(document.fullscreenElement !== null);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	const toggle = useCallback(() => {
		// 被拒（非用户手势、iframe 没 allowfullscreen、权限策略）就当没点过：
		// 按钮状态由 fullscreenchange 决定，这里不必自己收尾
		if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
		else void document.documentElement.requestFullscreen?.().catch(() => undefined);
	}, []);

	return { supported, active, toggle };
}
