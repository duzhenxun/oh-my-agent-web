/**
 * 「隐藏项目」的拆分（纯函数）：把排好序的项目列一分为二 —— 该画在侧栏里的、被用户藏起来的。
 *
 * 为什么要单独一个纯函数：隐藏是**纯展示**层面的偏好（`projectPrefs.hidden`），
 * 它既要跟 `normalizeCwd` 的规矩一致（旧数据里有带尾斜杠的 key，见 Sidebar 里那段注释），
 * 又不能碰项目本身的数据（会话、别名、置顶、顺序都还在，取消隐藏就原样回来）。
 * 顺手把「看不见的那几个」留给列表底部的「已隐藏 · N」入口，否则藏了就没法再点开。
 */
import { normalizeCwd } from "./path-utils.ts";

export function splitHiddenProjects<T extends { cwd: string }>(
	projects: T[],
	hidden: readonly string[],
): { visible: T[]; hidden: T[] } {
	const keys = new Set(hidden.map(normalizeCwd).filter((cwd) => cwd !== ""));
	const visible: T[] = [];
	const hiddenProjects: T[] = [];
	for (const project of projects) {
		if (keys.has(normalizeCwd(project.cwd))) hiddenProjects.push(project);
		else visible.push(project);
	}
	return { visible, hidden: hiddenProjects };
}
