/**
 * 「从别处把某个面板打开」的窄通道。
 *
 * 为什么需要它：面板的开关（`menuPanel`）只有 `App.tsx` 里那份 state 说了算，
 * 而有些触发点不住在 App 里 —— 比如右下角那只朗读小宠物右键「设置语音功能」。
 * 与其把 `setMenuPanel` 一层层透传，不如走一个和 `composer-focus.ts`、
 * `projects-panel.ts` 同一套的模块级事件：谁想开面板就广播一句。
 *
 * 只开**面板**，不带别的东西：真正的开关逻辑仍然只有 App 那一处。
 */
export type OpenablePanel = "voice" | "settings" | "bug";

const EVENT = "agent-web:open-panel";

/** 请 App 把某个面板打开（voice = 顶栏那颗「语音」，settings = 设置） */
export function requestOpenPanel(panel: OpenablePanel): void {
	try {
		window.dispatchEvent(new CustomEvent<OpenablePanel>(EVENT, { detail: panel }));
	} catch {
		// 没有 window（SSR / 单测）就算了：没人接就什么都不发生
	}
}

export function onOpenPanelRequest(callback: (panel: OpenablePanel) => void): () => void {
	const onCustom = (event: Event) => callback((event as CustomEvent<OpenablePanel>).detail);
	window.addEventListener(EVENT, onCustom);
	return () => window.removeEventListener(EVENT, onCustom);
}
