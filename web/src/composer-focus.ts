/**
 * 把光标放进输入框（点「新会话」之后的第一件事）。
 *
 * 为什么要在**点击的同一个任务里**同步调用：iOS Safari 只允许「用户手势内」的 focus
 * 弹出键盘。等网络往返回来再 focus，光标是进去了但键盘不出 —— 手机上就像没反应。
 * 所以这里不依赖 React 状态，直接找 DOM；Composer 那边另有一份「建好后兜底再 focus」。
 */
export function focusComposer(): void {
	if (typeof document === "undefined") return;
	const input = document.querySelector<HTMLTextAreaElement>(".composer-input");
	if (!input) return;
	input.focus();
	// 草稿可能不是空的：光标放到末尾，接着写就行
	const end = input.value.length;
	try {
		input.setSelectionRange(end, end);
	} catch {
		// 个别浏览器在不可见元素上会抛，忽略即可
	}
}
