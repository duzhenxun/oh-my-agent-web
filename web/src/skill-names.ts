/**
 * 技能「目录名 → 真名」。
 *
 * 为什么需要这一层：技能目录名是安装时那个 slug（`new-skill-3`），真名写在 `SKILL.md` 的 frontmatter 里
 * （`name: weather-forecast`）。两者经常对不上，而工具行只能从**路径**认出目录名 ——
 * 于是折叠行里会写「技能 New Skill 3」，正是用户最看不下去的那种随机编号
 * （用户 2026-10-30：「我要看到」的是 `Weather Forecast`，不是目录号）。
 *
 * 服务端 `GET /api/skills` 本来就把 `id` 和 `name` 一起给了（技能面板就在用），
 * 所以这里只做一件很轻的事：**首次需要时拉一次，把 id → name 记在模块里**。
 * 拉不到（老后端 / 离线 / 面板没开过）就退回目录名拼出来的样子，绝不挡住渲染 ——
 * 技能名只是个说法，不该让它拖住一整条消息。
 */
import { useCallback, useSyncExternalStore } from "react";

/** 目录名 → 技能真名（frontmatter 的 name） */
let names: Record<string, string> = {};
let loading: Promise<void> | null = null;
/** 订阅者的「版本号」：名字表到了就 +1，订阅的组件重渲染一次（useSyncExternalStore 的快照） */
let revision = 0;
const listeners = new Set<() => void>();

function notify(): void {
	revision += 1;
	for (const listener of listeners) listener();
}

/** 拉一次技能清单（幂等；失败也只会拉一次，不反复打扰后端） */
export function loadSkillNames(): void {
	if (loading) return;
	loading = fetch("/api/skills")
		.then((response) => (response.ok ? response.json() : null))
		.then((data: unknown) => {
			// 服务端回的是 `{ skills: [...], root }`（见 skill-routes.ts）；裸数组也认，免得下次又改一次
			const list = Array.isArray(data)
				? data
				: Array.isArray((data as { skills?: unknown } | null)?.skills)
					? ((data as { skills: unknown[] }).skills as unknown[])
					: null;
			if (!list) return;
			const next: Record<string, string> = {};
			for (const item of list) {
				const skill = item as { id?: unknown; name?: unknown };
				if (typeof skill.id === "string" && typeof skill.name === "string" && skill.name !== "") {
					next[skill.id] = skill.name;
				}
			}
			names = next;
			notify();
		})
		.catch(() => {
			// 拿不到就用目录名，不重试
		});
}

/** 同步查：这个目录对应的技能真名（没有就 null） */
export function skillNameOf(slug: string): string | null {
	return names[slug] ?? null;
}

function subscribe(listener: () => void): () => void {
	loadSkillNames();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getRevision(): number {
	return revision;
}

/**
 * 「名字表到了就重渲染一次」。
 *
 * 只在会画工具行的组件里调（MessageList 一处就够：它重渲染时子组件跟着重渲染，
 * 里面调 `describeTool` / `skillOf` 的那几行自然就换成真名）。
 * 不给每张工具卡都挂一份订阅 —— 三十条历史消息就是三十个订阅者，白开销。
 */
export function useSkillNames(): void {
	useSyncExternalStore(useCallback(subscribe, []), getRevision, getRevision);
}
