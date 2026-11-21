/**
 * 外观字号的服务端同步（ADR-0050）：快照里的 `settings.appearance` 变了就应用到浏览器。
 *
 * 为什么要这一层：字号原本只存在 localStorage，服务端的 agent 根本看不到、也改不到。
 * 现在 agent 在对话里说一句就能改（`appearance` 工具 → `set_settings` → 快照回推），
 * 浏览器这边必须有个人把它接住并真正应用。
 *
 * 三条规则：
 *   1. **`null` = 服务端没设过**：老用户 / 新机器继续用本机 localStorage 那份字号，
 *      我们不拿默认值去覆盖他调过的值；
 *   2. **设过就以服务端为准**：页面刷新后第一份快照就应用（换设备也一致）；
 *   3. **值没变就不动**：用户在本机面板里刚拖过的字号，不会被同一份旧快照按回去。
 */
import { setChatFont } from "./chat-display.ts";
import { setSidebarProjectFont, setSidebarSessionFont } from "./sidebar-font.ts";

export type AppearanceLike = { chatPx: number; projectPx: number; sessionPx: number };

function isValid(view: AppearanceLike): boolean {
	return Number.isFinite(view.chatPx) && Number.isFinite(view.projectPx) && Number.isFinite(view.sessionPx);
}

function keyOf(view: AppearanceLike): string {
	return `${view.chatPx}/${view.projectPx}/${view.sessionPx}`;
}

/**
 * 判定要不要应用（纯函数，单测用）：返回 `null` = 不动；返回字符串 = 新的基线（要应用）。
 */
export function appearanceDecision(lastKey: string | null, view: AppearanceLike | null | undefined): string | null {
	// 服务端没设过：清基线，交给本机 localStorage
	if (!view) return null;
	if (!isValid(view)) return null; // 非数字：别把 NaN 写进 CSS 变量
	const key = keyOf(view);
	if (key === lastKey) return null; // 没变：本机改过的值不能被旧快照按回去
	return key;
}

let lastKey: string | null = null;

/** 快照到手时调（App 里挂一次即可） */
export function syncAppearanceFromSnapshot(view: AppearanceLike | null | undefined): void {
	const next = appearanceDecision(lastKey, view);
	if (next === null) {
		// 值是 null（没设过）时把基线也清掉：之后它一旦被设上，第一份快照就要应用
		if (!view) lastKey = null;
		return;
	}
	lastKey = next;
	if (!view) return;
	setChatFont(view.chatPx);
	setSidebarProjectFont(view.projectPx);
	setSidebarSessionFont(view.sessionPx);
}

/** 测试用：回到「还没收到快照」的状态 */
export function resetAppearanceSync(): void {
	lastKey = null;
}
