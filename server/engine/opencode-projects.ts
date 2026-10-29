/**
 * opencode 的「会话目录清单」——只回答一个问题：侧栏该向哪些目录点名。
 *
 * 为什么需要它：ACP 的 `session/list` 是**目录作用域**的（opencode-sessions.ts 文件头有实测）：
 *   - 不带 cwd：只拿 acp 子进程自己那个目录的会话；
 *   - 带 `{cwd}`：只拿 `directory` **精确等于** cwd 的会话（不是整棵项目树）。
 * 所以「全部历史」= 把「有过会话的目录」逐个报给它。目录从哪来？
 *   - 工作台自己的工作区 + pi 的历史会话项目：只覆盖「在 pi 里也用过」的目录；
 *   - **opencode 自己的 `session.directory`**：这是全量答案（只在 opencode 里用过的目录差别很大）。
 * 所以这里读一次 SQLite —— **只读、只取目录一列、失败就算了**（返回空数组）。
 *
 * 为什么可以读：`export` 是会话正文的稳定出口（正文结构会变，所以走 CLI），
 * 而「有哪些目录有过会话」只是个索引，读不到就退化到前两个来源，不会让侧栏整体失败。
 * 依赖也现成：Node ≥22.19 自带 `node:sqlite`（实验性，但不需要装包）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** opencode 的库文件：跟随 XDG（它自己也是这么找数据的） */
function opencodeDbFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const xdg = env.XDG_DATA_HOME?.trim();
	const dataHome = xdg && xdg !== "" ? xdg : join(home, ".local", "share");
	return join(dataHome, "opencode", "opencode.db");
}

/**
 * 读「有过会话的目录」（`SELECT DISTINCT directory FROM session`）。
 *
 * 失败一律返回空数组：库文件不存在、被锁（opencode 正在写 WAL）、表结构变了、`node:sqlite` 用不了……
 * 这些都只该让「目录发现」退化成「只知道工作区 + pi 项目」，不该冒泡。
 */
export async function readOpencodeSessionDirs(
	options: { dbFile?: string; log?: (text: string) => void } = {},
): Promise<string[]> {
	const dbFile = options.dbFile ?? opencodeDbFile();
	if (!existsSync(dbFile)) return [];
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbFile, { readOnly: true });
		try {
			// 只读连接也可能撞上写锁（opencode 正在写 WAL）：等一下就走，别把侧栏刷新卡住
			try {
				db.exec("PRAGMA busy_timeout = 500");
			} catch {
				// PRAGMA 不被允许也不影响这次只读查询
			}
			const rows = db
				.prepare("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory <> ''")
				.all() as { directory?: unknown }[];
			return rows
				.map((row) => (typeof row.directory === "string" ? row.directory.trim() : ""))
				.filter((directory) => directory !== "");
		} finally {
			db.close();
		}
	} catch (error) {
		options.log?.(
			`读取 opencode 会话目录清单失败（退回工作区 + pi 项目）：${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}
