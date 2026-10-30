/**
 * 删除会话（侧栏 ⋯ → 删除 / 归档视图的批量删除）。
 *
 * 两条路，按引擎能力选：
 *   1. 引擎有原生删除（codex 的 `thread/delete`）→ 交给引擎，Codex Desktop 里也会消失；
 *   2. 否则（pi）→ **`purge` 为假**时沿用原来的做法：把会话文件改名成 `<名字>.deleted-<时间戳>`，
 *      扫描不到（列表里消失），但文件还在磁盘上，误删可以手动改回来；
 *      **`purge` 为真**时才是真删（`unlink`）。
 *
 * 默认**不真删文件**：删除是不可逆操作，工作台还没有废纸篓 —— 所以真删必须显式要（用户 2026-10-30：
 * “真删要不要给一个入口”→ A 方案：另给一颗「彻底删除」，两下确认，默认那颗仍然只是改名）。
 * 这一点也在两侧的提示文案里写明（界面说「可从磁盘恢复」还是「不可恢复」，必须跟这里一致）。
 */
import { rename, unlink } from "node:fs/promises";
import type { EnginePort } from "../engine/port.js";
import type { PiProject } from "../protocol.js";

/** 引擎侧「本来就没有」的错误文案（codex：no rollout / thread not found）→ 统一当作未找到 */
function isMissingError(message: string): boolean {
	return /no rollout|not found|不存在|已删除/i.test(message);
}

type DeleteResult =
	| { ok: true; mode: "engine" | "file" | "purged" | "gone"; movedTo?: string }
	| { ok: false; error: { code: string; message: string } };

export type DeleteOptions = {
	/**
	 * 真删（`unlink` 掉会话文件），而不是改名。
	 * 只对文件那条路有意义：引擎自己能删（codex）时两种模式结果一样。
	 * 默认 false —— 不给就还是「改名、可从磁盘恢复」那条安全路。
	 */
	purge?: boolean;
};

export function createSessionDeleter(deps: {
	engine: EnginePort;
	projects: () => PiProject[];
	/** 引擎自己的会话句柄（引擎 id 优先，没有就用文件路径） */
	handleOf: (conversationId: string) => string | null;
	/**
	 * 删完之后的本地清场：客户端视图、内存里的会话/消息/队列、引擎句柄都要放开。
	 * 以前只做了「客户端视图作废」，于是删掉的会话还在侧栏、还能点开、还能往里发消息。
	 */
	discard: (conversationId: string) => void;
	refresh: () => Promise<void>;
	pushSnapshot: () => void;
}): (conversationId: string, options?: DeleteOptions) => Promise<DeleteResult> {
	/**
	 * 「本来就不在了」也当删除成功（幂等）。
	 *
	 * 以前这里回 `session.not_found`，而且**不做本地清场** —— 于是侧栏里那条幽灵会话
	 * 永远删不掉，它所在的项目也就永远留在列表里（项目只在「一条会话都没有」时才消失）。
	 * 用户 2026-10-29 报的「删除「plugins」下的全部会话：成功 0 条，失败 1 条」就是它。
	 *
	 * 现在只做该做的事：把内存里那条会话/引擎句柄丢掉 + 刷新列表。目标状态已经达成，
	 * 报错只会让用户对着一个删不掉的项目反复点。
	 */
	const finishGone = async (conversationId: string): Promise<DeleteResult> => {
		deps.discard(conversationId);
		await deps.refresh().catch(() => undefined);
		deps.pushSnapshot();
		return { ok: true, mode: "gone" };
	};
	return async (conversationId, options) => {
		const purge = options?.purge === true;
		/** 从「当前列表」里找这条会话（找不到可能是列表还没扫到，见下面重扫） */
		const findInList = () =>
			deps
				.projects()
				.flatMap((project) => project.sessions)
				.find((item) => item.id === conversationId);
		/** 拿到文件后那条路：改名（默认）或真删（purge） */
		const byFile = async (sessionPath: string): Promise<DeleteResult> => {
			const target = `${sessionPath}.deleted-${Date.now()}`;
			try {
				if (purge) await unlink(sessionPath);
				else await rename(sessionPath, target);
			} catch (error) {
				// 真删时文件本来就不在 = 目标状态已达成，不该报失败（改名路径没有这种情况）
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (purge && code === "ENOENT") return finishGone(conversationId);
				return {
					ok: false,
					error: { code: "session.delete_failed", message: error instanceof Error ? error.message : String(error) },
				};
			}
			deps.discard(conversationId);
			await deps.refresh().catch(() => undefined);
			deps.pushSnapshot();
			return purge ? { ok: true, mode: "purged" } : { ok: true, mode: "file", movedTo: target };
		};

		let session = findInList();
		if (!session) {
			// 侧栏没列出来（比如引擎自己隐藏的会话：codex 临时目录里的随手跑）：
			// 只要宿主还知道它的句柄，仍然允许删 —— 否则界面上「删不掉也找不到」
			const handle = deps.handleOf(conversationId);
			if (!handle || !deps.engine.deleteSession) {
				/**
				 * 也可能只是**列表还没扫到**：pi 的会话清单有 10s 节流，刚建的会话（或刚在别的
				 * 地方落盘的会话）可能这一瞬间还不在列表里。
				 *
				 * 以前这里直接 `finishGone` —— 于是「删了」的提示弹出去了，文件还好好躺在磁盘上，
				 * 下一轮扫描它又回到侧栏（尤其是「彻底删除」：用户明确要求真删，结果什么都没删）。
				 * 所以强制重扫一次再找：找到就走文件那条路，真找不到才算「已经没了」。
				 */
				await deps.refresh().catch(() => undefined);
				session = findInList();
				if (!session) return finishGone(conversationId);
			} else {
				try {
					await deps.engine.deleteSession(handle);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return isMissingError(message)
						? finishGone(conversationId)
						: { ok: false, error: { code: "session.delete_failed", message } };
				}
				deps.discard(conversationId);
				await deps.refresh().catch(() => undefined);
				deps.pushSnapshot();
				return { ok: true, mode: "engine" };
			}
		}
		const engineHandle = session.engineSessionId ?? null;
		if (engineHandle && deps.engine.deleteSession) {
			try {
				await deps.engine.deleteSession(engineHandle);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return isMissingError(message)
					? finishGone(conversationId)
					: { ok: false, error: { code: "session.delete_failed", message } };
			}
			deps.discard(conversationId);
			await deps.refresh().catch(() => undefined);
			deps.pushSnapshot();
			return { ok: true, mode: "engine" };
		}

		const sessionPath = session.sessionPath ?? deps.handleOf(conversationId);
		if (!sessionPath) {
			// 列表里有、但没有可删的落盘文件：同样是「已经没了」，清场就完事
			return finishGone(conversationId);
		}
		return byFile(sessionPath);
	};
}
