/**
 * 改会话显示名：往会话文件追加一条 `session_info`（pi 自己的「会话名」条目）。
 *
 * 已打开的会话直接用它的 sessionManager（同一个文件句柄）；没打开的临时 open 一次再追加。
 * 单独成文件：ADR-0003 规定只有 `server/engine` 能碰 SDK，而 pi-sdk.ts 已贴近行数上限。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";

type Handle = { sessionManager: { getSessionFile: () => string | undefined } };

export async function renameSessionIn(
	sessions: Map<string, Handle>,
	sessionPath: string,
	name: string,
	sessionDir?: string,
): Promise<void> {
	const opened = [...sessions.values()].find((handle) => handle.sessionManager.getSessionFile() === sessionPath);
	const manager = opened
		? (opened.sessionManager as unknown as SessionManager)
		: SessionManager.open(sessionPath, sessionDir);
	manager.appendSessionInfo(name);
}
