/**
 * codex 的「项目 / 会话清单」提供者（对齐 codex 原生：项目就是 codex 的 project，会话就是 thread）。
 *
 * 数据全部来自 app-server：
 *   - `project/list`（原生项目：名字 + 多个 root + 原生排序 position）；
 *   - `thread/list`（原生会话：名字、cwd、projectId、模型、更新时间）。
 *
 * 分组规则（**只读，不改 codex 的任何东西**）：
 *   1. thread.projectId 有值 → 归到那个项目；
 *   2. 没有 projectId 但有 cwd → 归到「root 是 cwd 前缀」的项目（最长前缀胜出）；
 *   3. 都没匹配上 → 按 cwd 单独成组（不丢会话，也不硬塞进别人的项目）。
 *
 * 这条兜底很重要：本机实测 codex 的 threads.project_id 大量为 NULL（Desktop 只在某些路径下写入），
 * 只按 projectId 归类会让侧栏空掉。
 */
import { basename, sep } from "node:path";
import { isScratchCwd } from "./scratch.js";
import type { PiProject, PiSessionSummary } from "../protocol.js";
import type { CodexClient } from "./codex-transport.js";

/**
 * 拉会话时必须显式声明这两项，否则会「看不见大部分历史」（实测 0.162/0.163）：
 *   - `modelProviders: []` → 缺省时服务端只返回**当前配置的 provider** 的会话
 *     （本机 35 条非归档会话里，缺省只回了 13 条）；
 *   - `sourceKinds` 全给 → 缺省只回「交互式来源」，`exec` 起的会话会被吞掉。
 */
const ALL_SOURCES = ["cli", "vscode", "exec", "appServer", "subAgent", "unknown"] as const;

type CodexProjectRow = {
	id: string;
	name: string;
	roots: Array<{ path: string }>;
	position?: number;
	recencyAt?: number | null;
};

type CodexThreadRow = {
	id: string;
	name?: string | null;
	preview?: string | null;
	cwd?: string | null;
	projectId?: string | null;
	model?: string | null;
	createdAt?: number;
	updatedAt?: number;
	archived?: boolean | null;
};

const cwdOf = (thread: CodexThreadRow): string => thread.cwd ?? "";

/** cwd 是否落在某个 root 里（等于或在其下；避免 `/a/bc` 冒充 `/a/b`） */
function underRoot(cwd: string, root: string): boolean {
	if (cwd === "" || root === "") return false;
	if (cwd === root) return true;
	return cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * 纯分组：projects + threads → 侧栏形状。
 * 会话按 updatedAt 倒序；项目之间保持 codex 的 position 顺序。
 */
function groupThreads(projects: CodexProjectRow[], threads: CodexThreadRow[]): PiProject[] {
	const byProjectId = new Map(projects.map((project) => [project.id, project]));
	const roots = projects.flatMap((project) =>
		project.roots.map((root) => ({ projectId: project.id, path: root.path ?? "" })),
	);

	const groups = new Map<string, { project: CodexProjectRow | null; cwd: string; sessions: PiSessionSummary[] }>();
	const ensureGroup = (key: string, project: CodexProjectRow | null, cwd: string) => {
		const known = groups.get(key);
		if (known) return known;
		const created = { project, cwd, sessions: [] as PiSessionSummary[] };
		groups.set(key, created);
		return created;
	};

	// 先把所有项目建出来（没有会话的项目也要显示：原生侧栏就是这样的）
	for (const project of projects) {
		ensureGroup(`project:${project.id}`, project, project.roots[0]?.path ?? "");
	}

	for (const thread of threads) {
		if (thread.archived === true) continue;
		const cwd = cwdOf(thread);
		const explicit = thread.projectId ? byProjectId.get(thread.projectId) : undefined;
		let project = explicit ?? null;
		if (!project && cwd !== "") {
			// 最长前缀胜出：嵌套 root（monorepo）时归到最具体的那个项目
			const match = roots
				.filter((root) => underRoot(cwd, root.path))
				.sort((left, right) => right.path.length - left.path.length)[0];
			if (match) project = byProjectId.get(match.projectId) ?? null;
		}
		// 临时目录里的随手会话（`codex exec` 的一次性跑）不进侧栏；当前正在聊的那条
		// 仍然看得到 —— 侧栏会把 state.conversations 合进来（见 Sidebar）。
		if (!project && isScratchCwd(cwd)) continue;
		const key = project ? `project:${project.id}` : `cwd:${cwd || "unknown"}`;
		const group = ensureGroup(key, project, project?.roots[0]?.path ?? cwd);
		group.sessions.push({
			id: thread.id,
			engineSessionId: thread.id,
			title: (thread.name ?? "").trim() || (thread.preview ?? "").trim() || "(未命名会话)",
			startedAt: typeof thread.createdAt === "number" ? thread.createdAt * 1000 : 0,
			updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : 0,
			cwd: cwd || group.cwd,
			model: thread.model ?? null,
		});
	}

	return (
		[...groups.values()]
			.map((group) => ({
				cwd: group.cwd,
				name: group.project?.name?.trim() || basename(group.cwd) || "未分项目",
				sessions: [...group.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
			}))
			// 有会话的排前面；同组内按最近更新时间
			.sort((left, right) => {
				const leftAt = left.sessions[0]?.updatedAt ?? 0;
				const rightAt = right.sessions[0]?.updatedAt ?? 0;
				return rightAt - leftAt;
			})
	);
}

/** 分页拉全部会话（跟随 nextCursor；上限 5 页，避免超大库把首屏拖死） */
async function listAllThreads(client: CodexClient, pageSize = 200): Promise<CodexThreadRow[]> {
	const rows: CodexThreadRow[] = [];
	let cursor: string | null = null;
	type Page = { data?: CodexThreadRow[]; nextCursor?: string | null };
	for (let page = 0; page < 5; page += 1) {
		const result: Page = await client.request<Page>("thread/list", {
			limit: pageSize,
			modelProviders: [],
			sourceKinds: [...ALL_SOURCES],
			...(cursor ? { cursor } : {}),
		});
		rows.push(...(result?.data ?? []));
		cursor = result?.nextCursor ?? null;
		if (!cursor) break;
	}
	return rows;
}

/**
 * 保证某个目录在 codex 里有一个原生 project（新建会话时用）。
 *
 * - 已有覆盖它的项目（root 相同或是其前缀）→ 直接用（取最长前缀，嵌套目录不会归错）；
 * - 没有 → `project/create`，`idempotencyKey` 按目录固定，重复点不会建出两个；
 * - 老版本 codex 没有 `project/*` → 返回 null，退回「只有 cwd」的老行为（不阻塞建会话）。
 */
export async function ensureCodexProject(client: CodexClient, workspace: string): Promise<string | null> {
	if (!workspace) return null;
	try {
		const list = await client.request<{ data?: Array<{ id: string; roots?: Array<{ path?: string }> }> }>(
			"project/list",
			{},
		);
		const match = (list?.data ?? [])
			.flatMap((project) => (project.roots ?? []).map((root) => ({ id: project.id, path: root.path ?? "" })))
			.filter((root) => root.path !== "" && (workspace === root.path || workspace.startsWith(`${root.path}${sep}`)))
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (match) return match.id;
		const created = await client.request<{ project?: { id?: string } }>("project/create", {
			name: basename(workspace) || workspace,
			roots: [{ path: workspace }],
			idempotencyKey: `agent-web:${workspace}`,
		});
		return created?.project?.id ?? null;
	} catch {
		return null;
	}
}

export function createCodexSessionsProvider(options: {
	client: CodexClient;
	log?: (text: string) => void;
	/** 一次最多拉多少条会话（原生默认分页更小，这里取够侧栏用） */
	limit?: number;
}): () => Promise<PiProject[]> {
	return async () => {
		const [projects, threads] = await Promise.all([
			options.client
				.request<{ data?: CodexProjectRow[] }>("project/list", { sortKey: "position" })
				.then((result) => result?.data ?? [])
				.catch((error) => {
					// 老版本 codex 没有 project/*：退化成「只按 cwd 分组」，不要让侧栏整体失败
					options.log?.(`codex project/list 不可用：${error instanceof Error ? error.message : String(error)}`);
					return [] as CodexProjectRow[];
				}),
			listAllThreads(options.client, options.limit ?? 200),
		]);
		return groupThreads(projects, threads);
	};
}
