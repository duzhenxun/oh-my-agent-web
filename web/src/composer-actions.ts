/**
 * 「对话操作」快捷键（发送 / 排队 / 插队 / 停止）的传递通道。
 *
 * 为什么用一个模块级事件而不是把 Composer 的 `submit` 提到 App：
 *   - 这几条动作的全部先决条件（草稿、附件、running 状态、引擎能力、surface 视图）都在 Composer 里，
 *     提到上层等于把这些状态也搬上去 —— 一次重构换四条快捷键，不划算；
 *   - App 层只负责「哪个键对应哪个动作」（`runShortcut` 的分发），不知道动作怎么执行；
 *   - 模块级事件天然只有一份，不需要在组件树里逐层穿 props。
 *
 * 与 `voice-control.ts` / `shortcut-sheet.ts` 的模块状态同一个模式。
 */

export type ComposerAction = "send" | "queue" | "steer" | "stop";

const COMPOSER_ACTION_EVENT = "agent-web:composer-action";

/** 派发一条动作（App 的快捷键分发器调它） */
export function requestComposerAction(action: ComposerAction): void {
	window.dispatchEvent(new CustomEvent<ComposerAction>(COMPOSER_ACTION_EVENT, { detail: action }));
}

/** 订阅动作（Composer 挂一份；返回取消订阅） */
export function onComposerAction(handler: (action: ComposerAction) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<ComposerAction>).detail;
		if (detail) handler(detail);
	};
	window.addEventListener(COMPOSER_ACTION_EVENT, listener);
	return () => window.removeEventListener(COMPOSER_ACTION_EVENT, listener);
}
