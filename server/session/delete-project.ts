/**
 * 删除项目（侧栏项目菜单 → 删除项目）：真删这个项目的全部会话，并把项目目录一起删掉。
 *
 * 用户 2026-11-04：「删除项目时就要真实删掉」。以前只逐条真删会话文件，
 * `sessions/<编码后的 cwd>/` 目录被留了下来（空目录 + 历史上 `.deleted-*` 的残留）。
 *
 * 规则：
 *   1. 逐条走 `deleteSession({ purge: true })`，复用会话删除的清场（内存、引擎句柄、草稿）；
 *   2. 只有目录里**已经没有任何 `.jsonl`** 时才删目录 —— 有会话删失败就留着目录，不误伤；
 *   3. 目录必须是 `sessionsRoot` 的直接子目录，否则不碰（防御路径错误）；
 *   4. 删目录时连带清掉 `*.deleted-<时间戳>` 这类旧残留（它们属于这个项目）。
 *
 * 引擎自己的会话（codex / claude 等）没有落在 sessionsRoot 下，只走第 1 步，不会动目录。
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ProjectDeleteFailure = { id: string; message: string };

export type ProjectDeleteResult =
	| { ok: true; deleted: number; failed: ProjectDeleteFailure[]; removedDirs: number }
	| { ok: false; error: { code: string; message: string } };

type SessionLike = { id: string; sessionPath?: string };

export function createProjectDeleter(deps: {
	/** 当前已知的项目（与会话删除共用同一份列表） */
	projects: () => { cwd: string; sessions: SessionLike[] }[];
	/** pi 的会话根目录：`~/.pi/agent/sessions` */
	sessionsRoot: string;
	/** 单条会话删除（应为 purge 真删） */
	deleteSession: (id: string) => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
}): (cwd: string) => Promise<ProjectDeleteResult> {
	const root = resolve(deps.sessionsRoot);

	/** 目录里还有会话文件就不删；否则整个目录（含 .deleted-* 残留）删掉。返回是否真删了 */
	const removeDirIfNoSessions = async (dir: string): Promise<boolean> => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return false; // 目录已经不在了
		}
		if (names.some((name) => name.endsWith(".jsonl"))) return false;
		await rm(dir, { recursive: true, force: true });
		return true;
	};

	return async (cwd) => {
		const project = deps.projects().find((item) => item.cwd === cwd);
		if (!project) {
			return { ok: false, error: { code: "project.not_found", message: "这个项目已经不在列表里了（刷新一下再试）" } };
		}

		// 先记下每条会话所在的目录（删完之后列表会变，别再回头查）
		const dirs = new Set<string>();
		for (const session of project.sessions) {
			if (!session.sessionPath) continue;
			const dir = dirname(resolve(session.sessionPath));
			if (dirname(dir) === root) dirs.add(dir);
		}

		let deleted = 0;
		const failed: ProjectDeleteFailure[] = [];
		for (const session of project.sessions) {
			const result = await deps.deleteSession(session.id);
			if (result.ok) deleted += 1;
			else failed.push({ id: session.id, message: result.error.message });
		}

		let removedDirs = 0;
		for (const dir of dirs) {
			if (await removeDirIfNoSessions(dir)) removedDirs += 1;
		}
		return { ok: true, deleted, failed, removedDirs };
	};
}
