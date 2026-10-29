/**
 * 把一条会话移到另一个项目（改工作目录 cwd）——从 runtime 拆出的独立模块。
 *
 * 语义：**搬家，不是派生**。会话 id 与全部历史都不变，只改两处：
 *   1. 会话文件首行 header 的 `cwd`（pi 恢复会话时按它起 cwd）；
 *   2. 文件所在的会话目录（pi 的 `~/.pi/agent/sessions/<encoded-cwd>/`）。
 *
 * 为什么不是 `SessionManager.forkFrom`：那会新造一个会话（新 id、新文件），
 * 界面上正在看的 URL / 统计 / 置顶都会跟着失联。搬家只动 header + 目录，
 * 其余一切照旧，最贴合「拖到别的项目」这个动作。
 */
import type { EnginePort } from "../engine/port.js";
import type { PiProject } from "../protocol.js";
import { defaultPiSessionsRoot, moveSessionFile } from "./pi-sessions.js";
import { piAgentDir } from "./pi-sessions-provider.js";

type MoveResult = { ok: true; workspace: string } | { ok: false; error: { code: string; message: string } };

export function createSessionMover(deps: {
	engine: EnginePort;
	projects: () => PiProject[];
	/** 引擎自己的会话句柄（pi = 文件路径，codex = threadId） */
	handleOf: (conversationId: string) => string | null;
	/** 这个会话是不是正在跑回合 / 等审批（在跑的会话不能搬家） */
	isBusy: (conversationId: string) => boolean;
	/** 放开 opener 里「已打开」的登记：搬家后要按新路径重新扫描，旧句柄作废 */
	forget: (conversationId: string) => void;
	/** 把内存里会话元数据的 workspace 一起改掉（否则扫描回来前后会各出一条） */
	relabel: (conversationId: string, workspace: string) => void;
	refresh: () => Promise<void>;
	pushSnapshot: () => void;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	/** 覆盖会话存储根（可选）；默认 `~/.pi/agent/sessions` */
	sessionsRoot?: string;
}): (conversationId: string, workspace: string) => Promise<MoveResult> {
	const sessionsRoot = deps.sessionsRoot ?? defaultPiSessionsRoot(piAgentDir());

	return async (conversationId, workspace) => {
		const session = deps
			.projects()
			.flatMap((project) => project.sessions)
			.find((item) => item.id === conversationId);
		const sessionPath = session?.sessionPath ?? deps.handleOf(conversationId);

		// 只有落盘的会话能搬家：临时会话没有文件，codex 的 thread 换 cwd 语义也不成立
		if (!session || !sessionPath) {
			return {
				ok: false,
				error: { code: "session.not_found", message: "这条会话没有可移动的落盘文件" },
			};
		}
		if (session.cwd === workspace) {
			return { ok: true, workspace }; // 没动，别白跑一遍磁盘
		}
		if (deps.isBusy(conversationId)) {
			return { ok: false, error: { code: "session.busy", message: "会话正在运行，先等它结束再移动" } };
		}

		try {
			// 先放开引擎句柄：文件马上要换位置，旧句柄再写会写回旧路径
			await Promise.resolve(deps.engine.closeSession?.(conversationId)).catch(() => undefined);
			deps.forget(conversationId);
			await moveSessionFile(sessionsRoot, sessionPath, workspace);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`移动会话失败：${message}`, "error");
			return { ok: false, error: { code: "session.move_failed", message } };
		}

		deps.relabel(conversationId, workspace);
		await deps.refresh().catch(() => undefined);
		deps.pushSnapshot();
		return { ok: true, workspace };
	};
}
