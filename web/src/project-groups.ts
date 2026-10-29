/**
 * 侧栏那一列「项目 → 会话」的合成（纯函数）。
 *
 * 数据有两个来源，形状还不一样：
 *   1. `piProjects`：pi 会话存储扫出来的**事实**（cwd 来自会话 header，项目名 = cwd 最后一段）；
 *   2. `conversations`：本进程内存里的会话元数据（刚建的会话、刚改的名字、刚搬的家都在这里）。
 *
 * 以前这段是内联在 `Sidebar.tsx` 里的 `groups.find(item => item.cwd === workspace)` ——
 * **字符串全等**。用户报的 bug 就是栽在这行上：新建项目时 macOS 的原生目录选择框回的是
 * `/a/b/`（带尾斜杠），pi 写进 header 的是 `/a/b`，于是同一个项目在侧栏里出现两个组、
 * 里面是同一条会话（都显示「运行中」）。
 *
 * 所以这里把三件事一次做对：
 *   - **按归一化后的 cwd 归组**（`normalizeCwd`）：`/a/b/` 与 `/a/b` 是同一个项目；
 *   - **一条会话只出现一次**：内存里那份是「刚发生的事实」（比如刚搬到别的项目），
 *     扫描那份可能还没刷新 —— 冲突时以内存为准，把扫盘那行从旧项目里摘掉；
 *   - **别名 / 顺序不受影响**：这里只管分组和会话归属，名字与排序仍由调用方处理。
 */
import { basename, normalizeCwd } from "./path-utils.ts";
import type { ConversationMeta, PiProject, PiSessionSummary } from "./types.ts";

/** 合成输入只用到这几个字段（`ConversationMeta` 满足它，造数据也不用凑齐字段） */
type LocalSession = Pick<ConversationMeta, "id" | "title" | "workspace" | "createdAt" | "updatedAt">;

/** 会话行（可选的 `sessionPath` 允许缺省：内存里新建的会话还没落盘） */
type SessionRow = PiSessionSummary;

/**
 * 把「扫盘的项目」和「内存里的会话」合成侧栏要画的那一列。
 *
 * @param ungroupedName 认不出 cwd（空串）时那个组的显示名（「未分组」/「Ungrouped」）
 */
export function buildProjectGroups(
	projects: PiProject[],
	conversations: LocalSession[],
	ungroupedName: string,
): PiProject[] {
	/** 归一化 cwd → 组（保证同一项目只有一个 key） */
	const byKey = new Map<string, PiProject>();
	const ordered: PiProject[] = [];
	const push = (key: string, cwd: string, name: string): PiProject => {
		const group: PiProject = { cwd, name, sessions: [] };
		byKey.set(key, group);
		ordered.push(group);
		return group;
	};

	for (const project of projects) {
		const key = normalizeCwd(project.cwd);
		// 扫盘那边理论上不会有重复 key（服务端按 header cwd 分组），但脏数据不该画出两个组
		const group = byKey.get(key) ?? push(key, project.cwd, project.name);
		for (const session of project.sessions) {
			if (group.sessions.some((each) => each.id === session.id)) continue;
			group.sessions.push(session);
		}
	}

	// 内存里的会话：id → 它「现在」属于哪个项目（扫盘那份可能还没刷新过来）
	const authoritative = new Map<string, { conversation: LocalSession; key: string }>();
	for (const conversation of conversations) {
		const key = normalizeCwd(conversation.workspace);
		// 认不出项目（空 cwd）的会话不当权威：那会把扫盘那边正确归属的行拽进「未分组」
		if (key === "") continue;
		authoritative.set(conversation.id, { conversation, key });
	}

	// 扫盘那行与内存所说冲突（刚搬过项目）→ 摘掉旧的那行，否则同一条会话会在两个项目里各画一行
	for (const group of ordered) {
		group.sessions = group.sessions.filter((session) => {
			const local = authoritative.get(session.id);
			return !local || local.key === normalizeCwd(group.cwd);
		});
	}

	// 「已经画出来了」的会话 id（跨项目）：同一条会话在任何情况下都只能有一行 ——
	// 否则认不出项目的那条（workspace 为空）会既留在原项目里、又被画进「未分组」
	const placed = new Set(ordered.flatMap((group) => group.sessions.map((session) => session.id)));

	for (const conversation of conversations) {
		if (placed.has(conversation.id)) continue;
		const key = normalizeCwd(conversation.workspace);
		const group =
			byKey.get(key) ??
			push(
				key,
				conversation.workspace,
				conversation.workspace === "" ? ungroupedName : basename(conversation.workspace),
			);
		const row: SessionRow = {
			id: conversation.id,
			title: conversation.title || "新对话",
			startedAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
			cwd: conversation.workspace,
			model: null,
			sessionPath: "",
		};
		// 新会话排在最前面（扫盘那份按创建时间倒序，新会话本来就该在最上面）
		group.sessions.unshift(row);
		placed.add(row.id);
	}

	// 一条会话都没有的项目不画：pi 的项目列表本来就只从会话反推出来，
	// 清空（或全搬走）之后那个组已不存在 —— 留着就是一个点不开的空壳。
	return ordered.filter((group) => group.sessions.length > 0);
}
