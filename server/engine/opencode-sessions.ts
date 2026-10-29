/**
 * opencode 的「项目 / 会话清单」提供者 + 历史数据的读取口（export / delete）。
 *
 * 数据来源两条，各管一件事：
 *   1. **清单**：走 ACP 的 `session/list`（同一个子进程，零额外开销），返回
 *      `{sessionId, cwd, title, updatedAt}` —— 没有 startedAt / model（这两个只能给 null）。
 *
 *      **`session/list` 是「目录作用域」的（opencode 1.19.0 实测）**：
 *        - 不带参数：只返回 acp 子进程 cwd 那个目录的会话；
 *        - 带 `{cwd}`：只返回 `directory` **精确等于**它的会话（不是整棵项目树，也不按 git 根合并）。
 *      曾经以为不带参就是全局的，于是侧栏只看得到「宿主从哪个目录启动」那一个目录，其余全丢。
 *      现在的做法是**逐个目录点名**：宿主给出「有过会话的目录集合」
 *      （见 wiring.ts 的 opencodeWorkspaces / opencode-projects.ts），这里并发点名 + 按 sessionId 去重。
 *   2. **转录与统计**：走 CLI `opencode export <sid>`（stdout 是纯 JSON，日志走 stderr）。
 *      为什么不自己读 SQLite：会话正文的结构会变，`export` 是它自己给的稳定出口
 *      （「有哪些目录有过会话」这种索引才敢只读一次，见 opencode-projects.ts）。
 *
 * 分组规则与 codex / dsh 保持一致：按 cwd 分组、组名取目录名、临时目录里的会话不进侧栏。
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { killTree, resolveCli } from "../util/spawn-cli.js";
import type { PiProject, PiSessionSummary } from "../protocol.js";
import type { OpencodeExport } from "./opencode-map.js";
import { isScratchCwd } from "./scratch.js";
import type { OpencodeClient } from "./opencode-transport.js";

/** `session/list` 返回的一行 */
type OpencodeSessionRow = {
	sessionId?: string;
	cwd?: string;
	title?: string;
	updatedAt?: string;
};

/** 单个项目的 `session/list` 超时：侧栏刷新不该被一个卡住的项目拖死 */
const PROJECT_LIST_TIMEOUT_MS = 10_000;

const timestampOf = (value: string | undefined): number => {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 纯分组：`session/list` 的行 → 侧栏形状。
 *
 * - 临时目录（/tmp、/var/folders…）里的一次性会话丢掉，别塞噪音进侧栏；
 * - 同 cwd 归一组，组内按更新时间倒序；组之间按「最近一条会话」倒序；
 * - 没有标题的会话不编名字（opencode 自己会给「New session - …」，照它的原文显示）。
 */
function groupOpencodeSessions(rows: OpencodeSessionRow[]): PiProject[] {
	// 逐个项目点名时同一条会话会被问到多次（项目根与它的子目录都解析到同一个项目），先去重：
	// 同一个 sessionId 只留 updatedAt 最新的一条。
	const byId = new Map<string, OpencodeSessionRow>();
	for (const row of rows) {
		const id = row.sessionId;
		if (!id) continue;
		const previous = byId.get(id);
		if (!previous || timestampOf(row.updatedAt) >= timestampOf(previous.updatedAt)) byId.set(id, row);
	}

	const groups = new Map<string, { cwd: string; name: string; sessions: PiSessionSummary[] }>();
	for (const row of byId.values()) {
		const id = row.sessionId;
		if (!id) continue;
		const cwd = row.cwd ?? "";
		if (isScratchCwd(cwd)) continue;
		const updatedAt = timestampOf(row.updatedAt);
		const group = groups.get(cwd) ?? {
			cwd,
			name: basename(cwd) || cwd || "未分项目",
			sessions: [] as PiSessionSummary[],
		};
		group.sessions.push({
			id,
			engineSessionId: id,
			title: (row.title ?? "").trim() || "(未命名会话)",
			// ACP 不给创建时间：用更新时间兜底（侧栏只按 updatedAt 排序，不会显示错）
			startedAt: updatedAt,
			updatedAt,
			cwd,
			model: null,
		});
		groups.set(cwd, group);
	}
	return [...groups.values()]
		.map((group) => ({
			cwd: group.cwd,
			name: group.name,
			sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
		}))
		.sort((left, right) => (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0));
}

export function createOpencodeSessionsProvider(options: {
	client: OpencodeClient;
	/**
	 * 候选项目目录（每个都会带 `{cwd}` 调一次 `session/list`，结果合并去重）。
	 *
	 * 为什么必须给：`session/list` 是项目作用域的（见文件头），不给就只能看到 acp 子进程所在
	 * 目录那一个项目。返回空数组时退回一次无参调用（跟随子进程 cwd），不至于整个侧栏空掉。
	 */
	workspaces?: () => Promise<string[]> | string[];
	log?: (text: string) => void;
	/**
	 * 结果缓存时长（默认 **0 = 不缓存**）。
	 *
	 * 为什么不缓存：`session/list` 是一次 ACP 往返（毫秒级），而宿主的刷新器已经有一层最小间隔；
	 * 再叠一层缓存只会制造「删掉的会话在侧栏里赖着不走」（删除后的强制刷新会读到旧值）。
	 * 需要时可以显式传一个值（测试用）。
	 */
	cacheMs?: number;
	now?: () => number;
}): () => Promise<PiProject[]> {
	const cacheMs = options.cacheMs ?? 0;
	const now = options.now ?? Date.now;
	let cached: { at: number; value: PiProject[] } | null = null;

	/**
	 * 候选目录：去掉空串与重复。
	 *
	 * 故意**不**过滤「目录已经不存在」的：历史会话还在，点不开是用户自己删了目录的事；
	 * pi / codex / dsh 的侧栏也是这个口径（按会话里记的 cwd 分组）。实测点名不存在的目录
	 * 也不会在 opencode 的库里留下任何记录（就是空结果）。
	 */
	const targets = async (): Promise<(string | undefined)[]> => {
		let raw: string[] = [];
		try {
			raw = (await options.workspaces?.()) ?? [];
		} catch (error) {
			options.log?.(`枚举 opencode 候选项目目录失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const dirs = [...new Set(raw.map((dir) => dir.trim()).filter((dir) => dir !== ""))];
		return dirs.length > 0 ? dirs : [undefined];
	};

	/** 并发点名所有项目。单个项目失败不影响其它项目（侧栏能显示多少是多少） */
	const fetchAll = async (): Promise<PiProject[]> => {
		const list = await targets();
		const settled = await Promise.allSettled(
			list.map((cwd) =>
				options.client.request<{ sessions?: OpencodeSessionRow[] }>("session/list", cwd ? { cwd } : {}, {
					timeoutMs: PROJECT_LIST_TIMEOUT_MS,
				}),
			),
		);
		const rows: OpencodeSessionRow[] = [];
		for (const [index, item] of settled.entries()) {
			if (item.status === "fulfilled") {
				rows.push(...(item.value?.sessions ?? []));
				continue;
			}
			const cwd = list[index] ?? "(默认)";
			const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
			options.log?.(`读取 opencode 会话清单失败（${cwd}）：${reason}`);
		}
		return groupOpencodeSessions(rows);
	};

	return async () => {
		if (cacheMs > 0 && cached && now() - cached.at < cacheMs) return cached.value;
		let value: PiProject[];
		try {
			value = await fetchAll();
		} catch (error) {
			// 清单读不到不该让侧栏整体失败：给出上一次的结果（可能为空），并留一条日志
			options.log?.(`读取 opencode 会话清单失败：${error instanceof Error ? error.message : String(error)}`);
			return cached?.value ?? [];
		}
		cached = { at: now(), value };
		return value;
	};
}

// ---------------------------------------------------------------------------
// CLI 出口：export / delete
// ---------------------------------------------------------------------------

/**
 * 跑一次 `opencode <args>`，收 stdout（`export` 的日志走 stderr，不混进来）。
 * 失败返回 null / 抛错由调用方决定 —— 历史读不到不该让对话区崩掉。
 */
function runOpencode(bin: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = resolveCli(bin, args, process.env);
		const child = spawn(command.file, command.args, {
			...command.options,
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			killTree(child);
			reject(new Error(`opencode ${args[0]} 超时`));
		}, options.timeoutMs ?? 30_000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-2000);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`opencode ${args[0]} 启动失败：${error.message}`));
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(new Error(`opencode ${args[0]} 退出（code ${code ?? "?"}）${stderr.trim() ? `：${stderr.trim()}` : ""}`));
		});
	});
}

/** 读一条会话的完整导出（JSON）。读不到返回 null（界面上就是「暂无历史」） */
export async function readOpencodeExport(
	bin: string,
	sessionId: string,
	options: { log?: (text: string) => void; timeoutMs?: number } = {},
): Promise<OpencodeExport | null> {
	try {
		const stdout = await runOpencode(bin, ["export", sessionId], { timeoutMs: options.timeoutMs });
		const start = stdout.indexOf("{");
		if (start < 0) return null;
		return JSON.parse(stdout.slice(start)) as OpencodeExport;
	} catch (error) {
		options.log?.(
			`读取 opencode 会话导出失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/** 删一条会话（opencode 原生删除：`opencode session delete <sid>`） */
export async function deleteOpencodeSession(bin: string, sessionId: string): Promise<void> {
	await runOpencode(bin, ["session", "delete", sessionId], { timeoutMs: 20_000 });
}
