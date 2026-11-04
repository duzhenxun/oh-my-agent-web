/**
 * 「项目管理」那一栏的开关桥。
 *
 * 为什么需要这一层：这一栏的开合状态是 `Sidebar` 自己的（`projectsOpen`，`useState(true)`），
 * 而快捷键在 `App` 里派发。两种接法：
 *  1. 把 state 提到 `App` —— 但侧栏收起时整个 `<Sidebar>` 根本不挂载，状态在那边本来就是
 *     「重开即默认展开」，提上去只会多一条要跟着清理的 prop；
 *  2. **模块级回调**（这里）：`Sidebar` 挂载时登记自己的 toggle，卸载时注销；
 *     `App` 按快捷键时调 `toggleProjects()`。跟 `composer-focus.ts` / `shortcut-sheet.ts`
 *     一样，走的是「不经过 React 状态的直接动作」。
 *
 * `toggleProjects()` 返回**有没有人接**：侧栏收起时没人登记（Sidebar 没挂载），
 * 调用方据此决定「那这一下就当作展开侧栏」。
 */
type Toggle = () => void;

let handler: Toggle | null = null;

/** `Sidebar` 挂载时登记；返回注销函数（放在 `useEffect` 的 cleanup 里） */
export function registerProjectsToggle(next: Toggle): () => void {
	handler = next;
	return () => {
		// 只注销自己那份：后挂载的实例可能已经把它换掉了
		if (handler === next) handler = null;
	};
}

/** 切换「项目管理」那一栏；返回 false = 当前没人接（侧栏没挂载） */
export function toggleProjects(): boolean {
	if (!handler) return false;
	handler();
	return true;
}
