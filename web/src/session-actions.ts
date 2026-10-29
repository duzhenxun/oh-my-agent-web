/**
 * 会话级的三个小动作：置顶 / 归档 / 从归档还原。
 *
 * 为什么抽出来：同一张菜单现在有两个入口 —— 侧栏那条会话行（右键 / ⋯）和
 * **顶栏中间那颗会话标题**（右键）。两处要是各写一份，最容易出事的就是这条纪律：
 *
 *   会话偏好（`settings.sessionPrefs`）是**整表覆盖**写的。
 * 拿闭包里那份旧快照去算，连点两下「归档」就会互相覆盖（第二个请求覆盖掉第一个的结果，
 * 前一条又被放出来）。所以这里一律**从 store 读最新快照**再算，调用方不用操心。
 */
import { getAppState } from "./store.ts";
import { setSettings } from "./ws.ts";
import { showToast } from "./toast.ts";
import type { SessionPrefs } from "./types.ts";

/** 最新一份会话偏好（没快照时给空表） */
export function latestSessionPrefs(): SessionPrefs {
	return getAppState().snapshot?.settings.sessionPrefs ?? { pinned: [], archived: [], order: [] };
}

/** 整表覆盖写：只给要改的那几列，其余沿用最新的 */
export function patchSessionPrefs(patch: Partial<SessionPrefs>): void {
	setSettings({ sessionPrefs: { ...latestSessionPrefs(), ...patch } });
}

/** 置顶 / 取消置顶（新置顶的排最前，跟侧栏的排序规则一致） */
export function toggleSessionPin(id: string): void {
	const prefs = latestSessionPrefs();
	patchSessionPrefs({
		pinned: prefs.pinned.includes(id) ? prefs.pinned.filter((each) => each !== id) : [id, ...prefs.pinned],
	});
}

/** 从归档里还原（没归档就什么也不做） */
export function restoreSession(id: string): void {
	const prefs = latestSessionPrefs();
	if (!prefs.archived.includes(id)) return;
	patchSessionPrefs({ archived: prefs.archived.filter((each) => each !== id) });
}

/**
 * 归档一条会话 + 给一条**可撤销**的提示。
 *
 * 归档会把会话从列表里藏起来，误点一下就"不见了"，所以提示里给「撤销」和「查看」
 * （跳到已归档视图）。文案由调用方传 `t` 进来 —— 这里不引 hooks，保持纯逻辑。
 */
export function archiveSession(
	id: string,
	title: string,
	t: (zh: string, en?: string) => string,
	onView?: () => void,
): void {
	const prefs = latestSessionPrefs();
	if (prefs.archived.includes(id)) return;
	patchSessionPrefs({ archived: [...prefs.archived, id] });
	showToast({
		text: t(`已归档「${title || "未命名会话"}」`, `Archived "${title || "Untitled session"}"`),
		actions: [
			{ label: t("撤销", "Undo"), onClick: () => restoreSession(id) },
			...(onView ? [{ label: t("查看", "View"), onClick: onView }] : []),
		],
	});
}
