/**
 * 「资源指纹」：那些**会进系统提示词 / 工具清单**的东西变了没有。
 *
 * 为什么需要它：pi 的系统提示词是 `resourceLoader` 在**建会话时**拼出来的（见 pi-sdk 的
 * `startSession`），之后一直不变。用户在界面里关掉一个技能、加一个 MCP 服务器、改一行
 * `AGENTS.md`，已经打开的那条会话还是旧的那份 —— 提示词里技能还在、MCP 工具还连不上。
 *
 * 反过来「每轮都无脑 `session.reload()`」也不成：reload 会重跑扩展、重连 MCP，
 * 每条消息都等一遍连接只能算卡住。所以每轮先比一次指纹，**真的变了才重载**。
 *
 * 指纹算的是「路径 + mtime + size」而不是内容哈希：
 *   - 技能启停是**改名**（`SKILL.md` ↔ `.SKILL.md.disabled`），目录 mtime 会变；
 *   - 配置文件、`AGENTS.md` 改一个字 mtime 就变，读全文不值当。
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type WatchedPath = {
	/** 绝对路径：文件或目录都行 */
	path: string;
	/**
	 * 往下看几层。
	 *   0 = 只看这条自己（文件、或「目录的 mtime」）；
	 *   2 = 技能目录：`<dir>/<技能>/SKILL.md` 改名时变的是 `<dir>/<技能>`，所以必须看两层。
	 */
	depth?: number;
};

/** 把一条路径展开成指纹片段（不存在也记一笔：删掉/新建同样要算「变了」） */
function describe(path: string, depth: number, out: string[]): void {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		out.push(`${path}:missing`);
		return;
	}
	// mtimeMs 带小数（纳秒精度换算），不要取整：同一秒里连改两次也要能分辨
	out.push(`${path}:${stat.mtimeMs}:${stat.size}`);
	if (!stat.isDirectory() || depth <= 0) return;

	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch {
		return; // 读不了目录（权限）就当只看它自己，不因为读不了就每次都说「变了」
	}
	entries.sort();
	for (const entry of entries) describe(join(path, entry), depth - 1, out);
}

/**
 * 算一份指纹（sha1）。
 *
 * `extra` 给「路径之外、但同样改提示词」的东西：比如设置里的「想想」条数、
 * 子代理模板的启停（它们直接决定 `suggestionGuidance` / `SUBAGENT_GUIDANCE` 那段文字）。
 */
export function resourceSignature(paths: WatchedPath[], extra: readonly string[] = []): string {
	const parts: string[] = [];
	for (const { path, depth = 0 } of paths) describe(path, depth, parts);
	parts.push(...extra);
	return createHash("sha1").update(parts.join("\n")).digest("hex");
}
