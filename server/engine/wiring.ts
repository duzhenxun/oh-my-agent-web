/**
 * 引擎接线（index.ts 的 400 行护栏 + 一处装配）。
 *
 * 把三件事绑在一起，因为它们必须指向**同一批实例**：
 *   1. 注册表（有哪些引擎、怎么造）；
 *   2. codex 的 app-server 客户端（引擎与会话清单共用一个子进程）；
 *   3. 目录（每个引擎的历史会话从哪来）。
 *
 * codex 客户端构造时不 spawn：机器上没装 codex 也能正常启动，只有在切到它时才报错。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiProject } from "../protocol.js";
import { createBuiltinEngineRegistry } from "./builtin.js";
import type { CodexSubagentPolicy } from "./codex.js";
import { enabledSubagentSpecs, readSubagentSettings } from "../subagents/profile-store.js";
import { createEngineCatalog, type EngineCatalog } from "./catalog.js";
import { createClaudeSessionsProvider } from "./claude-sessions.js";
import { createClaudeClient } from "./claude-transport.js";
import { createCodexSessionsProvider } from "./codex-sessions.js";
import type { CodexClient } from "./codex-transport.js";
import { createCodexClient } from "./codex-transport.js";
import { createDshClient } from "./dsh-transport.js";
import { writeDshSuggestionPatch } from "./dsh-prompt-patch.js";
import { suggestionGuidance } from "./suggestion-guidance.js";
import { NARRATE_GUIDANCE } from "./narrate-guidance.js";
import { createDshSessionsProvider } from "./dsh-sessions.js";
import { createOpencodeSessionsProvider } from "./opencode-sessions.js";
import { readOpencodeSessionDirs } from "./opencode-projects.js";
import { createOpencodeClient } from "./opencode-transport.js";
import type { EngineRegistry } from "./registry.js";

/** opencode 目录清单的缓存时长：它是「要逐个点名多少个目录」的依据，不必每次刷新都开一次库 */
const OPENCODE_DIRS_TTL_MS = 30_000;

type EngineWiring = {
	registry: EngineRegistry;
	catalog: EngineCatalog;
	/** 启动时选定的引擎（未注册的名字回落到 pi，并已在日志里报告） */
	resolved: ReturnType<EngineRegistry["resolve"]>;
	/** 退出时收掉外部引擎的子进程（codex app-server） */
	close: () => void;
	/**
	 * codex 的 app-server 客户端（与会话 / 引擎共用一个子进程）。
	 * MCP / 插件面板要读 codex 自己的 `config/read`、`plugin/list` —— 复用这一个，
	 * 不另开第二个子进程（两份配置视图还会互相看不见对方刚写的东西）。
	 */
	codexClient: CodexClient;
};

/**
 * 读 `<patchDir>/default-model.json`（`{"provider":"…","model":"…"}` 或 `{"id":"provider/model"}`）。
 *
 * 为什么要有它：把自定义 provider 通过 `--patch` 带给 acp 之后，ACP 的 `session/new`
 * 仍然按它自己的默认路由给 `currentValue`（实测 `agent-default-model` 不生效），
 * 于是「新会话默认用哪个模型」必须由我们自己指定。
 */
function readDshDefaultModel(dir: string): string | null {
	const file = join(dir, "default-model.json");
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; provider?: unknown; model?: unknown };
		if (typeof parsed.id === "string" && parsed.id.trim() !== "") return parsed.id.trim();
		if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
			return `${parsed.provider}/${parsed.model}`;
		}
		return null;
	} catch {
		return null;
	}
}

export function createEngineWiring(options: {
	/** AGENT_WEB_ENGINE 的值 */
	engineName: string;
	codexBin: string;
	codexHome: string | null;
	dshBin: string;
	dshHome: string | null;
	dshModel: string | null;
	/** 环境里显式给的 patch（AGENT_WEB_DSH_PATCH） */
	dshPatches?: string[];
	/** 用户 patch 目录（默认 `<dataDir>/dsh-patches`）：里面的 *.yml 按文件名顺序叠加 */
	dshPatchDir?: string;
	/** opencode 可执行文件 + 额外 acp 参数 + 新会话默认模型 */
	opencodeBin: string;
	opencodeArgs?: string[];
	opencodeModel?: string | null;
	/** claude 的 ACP 适配器（`claude-code-acp` / 改名后的 `claude-agent-acp`，空 = 自动探测）+ 额外参数 + 新会话默认模型 */
	claudeBin: string;
	claudeArgs?: string[];
	claudeModel?: string | null;
	/** 当前工作区（新会话默认目录；也当 opencode 子进程的 cwd） */
	workspace: string;
	/** pi 的历史会话扫描器（index 用 piAgentDir + dataDir 装配） */
	piSessions: () => Promise<PiProject[]>;
	onNotice: (text: string, level?: "info" | "warn" | "error") => void;
	onLog: (text: string, meta?: Record<string, unknown>) => void;
	/** 技能目录（pi 展开 `/skill:xxx` 用）：由 index 传入本工作台的 skills 目录 */
	skillPaths?: string[];
	/**
	 * 子代理模板目录（pi 的 agentDir，默认 `~/.pi/agent`）。
	 * codex 的子代理模板从这里读：同一份模板，两个引擎看到的「有哪些子代理」是一致的。
	 */
	subagentAgentDir?: string;
	/**
	 * 「下一步建议」要几条（设置里「想想」的那个数，1~5）。
	 *
	 * pi / codex 拿到的是**惰性 getter**（建会话时现读）；dsh 只能在装配这里读一次
	 * —— 它的系统提示是进程级 patch，启动时 compose（见 dsh-prompt-patch.ts）。
	 */
	thinkCount?: () => number;
}): EngineWiring {
	const codexClient = createCodexClient({
		bin: options.codexBin,
		home: options.codexHome ?? undefined,
		log: (text) => options.onLog(text, { engine: "codex" }),
	});

	/**
	 * dsh 的 patch 叠加层：把「自定义 provider / 默认模型」带给 acp profile。
	 * 顺序 = 环境变量里显式给的 → 用户目录里的 `*.yml`（按文件名）。
	 */
	const patchDir = options.dshPatchDir;
	/**
	 * 「下一步建议」+「动手前先说话」：dsh 只能靠 patch 叠加层带进去
	 * （ACP 的 session/new 没有系统提示字段）。写在工作台自己的临时目录，
	 * **不**混进用户的 `dsh-patches`；排在最前面，用户自己写的 patch 仍有最终决定权。
	 */
	const suggestionPatchFile = writeDshSuggestionPatch(
		join(tmpdir(), "oh-my-agent-web"),
		[suggestionGuidance(options.thinkCount?.() ?? null), NARRATE_GUIDANCE].join("\n\n"),
	);
	const patchFiles = [
		suggestionPatchFile,
		...(options.dshPatches ?? []),
		...(patchDir && existsSync(patchDir)
			? readdirSync(patchDir)
					.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
					.sort()
					.map((name) => join(patchDir, name))
			: []),
	].filter((file) => existsSync(file));
	if (patchFiles.length > 0) options.onLog(`dsh：加载 ${patchFiles.length} 个 patch 叠加层`, { files: patchFiles });
	// 自定义 provider 的「默认模型」：patch 里的 agent-default-model 不会被 ACP 带到
	// session/new 的 configOptions（实测），所以这里用一个伴随文件显式指定。
	const defaultModel = options.dshModel ?? (patchDir ? readDshDefaultModel(patchDir) : null);

	const dshClient = createDshClient({
		bin: options.dshBin,
		home: options.dshHome ?? undefined,
		patches: patchFiles,
		log: (text) => options.onLog(text, { engine: "dsh" }),
	});

	/**
	 * opencode 的 ACP 客户端（懒启动：机器上没装 opencode 也能正常起工作台，切到它才拉起）。
	 * 会话清单与引擎共用同一个子进程。
	 */
	const opencodeClient = createOpencodeClient({
		bin: options.opencodeBin,
		args: options.opencodeArgs,
		// 别让它继承宿主进程的目录：opencode 的项目上下文跟着 cwd 走
		cwd: options.workspace,
		log: (text) => options.onLog(text, { engine: "opencode" }),
	});

	/**
	 * opencode 的候选目录：`session/list` 是**目录作用域**的，且带 `{cwd}` 只匹配 `directory` 完全相等的会话
	 * （不是整棵项目树，见 opencode-sessions.ts 文件头）。所以「全部历史」= 把「有过会话的目录」逐个点名。
	 * 三个来源取并集：
	 *   1. 当前工作区；
	 *   2. opencode 自己的 `session.directory`（全量答案，只读；见 opencode-projects.ts）；
	 *   3. pi 的历史会话项目（缓存过，热态 ~7ms）。
	 *
	 * 目录清单缓存 30s：它是「有多少个目录要点名」的依据，没必要每次刷新都开一次库；
	 * 会话本身不缓存（删了要立刻消失）。
	 */
	let opencodeDirsCache: { at: number; dirs: string[] } | null = null;
	const opencodeWorkspaces = async (): Promise<string[]> => {
		const dirs = [options.workspace];
		if (!opencodeDirsCache || Date.now() - opencodeDirsCache.at > OPENCODE_DIRS_TTL_MS) {
			const found = await readOpencodeSessionDirs({ log: (text) => options.onLog(text, { engine: "opencode" }) });
			opencodeDirsCache = { at: Date.now(), dirs: found };
		}
		dirs.push(...opencodeDirsCache.dirs);
		try {
			for (const project of await options.piSessions()) dirs.push(project.cwd);
		} catch (error) {
			options.onLog(
				`opencode：枚举候选项目目录失败（只用工作区）：${error instanceof Error ? error.message : String(error)}`,
				{
					engine: "opencode",
				},
			);
		}
		return dirs;
	};

	/**
	 * Claude Code 的 ACP 客户端（同样懒启动：没装适配器也能正常起工作台）。
	 * 历史会话清单不走它（直接读 `~/.claude/projects`），所以这里只给引擎用。
	 *
	 * `claudeBin` 空串 = 自动探测（老包 `claude-code-acp` / 新包 `claude-agent-acp`）。
	 */
	const claudeClient = createClaudeClient({
		bin: options.claudeBin || undefined,
		args: options.claudeArgs,
		cwd: options.workspace,
		log: (text) => options.onLog(text, { engine: "claude" }),
	});

	/**
	 * codex 的子代理策略：**每次建会话现读**模板库（面板改完，下一条新会话就生效）。
	 *
	 * 读不到模板目录（精简部署）= 关掉：宁可不给 spawn 工具，也不要让模型
	 * 拿着一堆它看不见的「类型」乱派活。
	 */
	const codexSubagentPolicy = (): CodexSubagentPolicy => {
		const dir = options.subagentAgentDir;
		if (!dir) return { enabled: false, concurrency: 4, profiles: [] };
		const settings = readSubagentSettings(dir);
		const profiles = enabledSubagentSpecs(dir).map((profile) => ({
			id: profile.id,
			label: profile.label,
			description: profile.description,
		}));
		return { enabled: settings.enabled, concurrency: settings.concurrency, profiles };
	};

	const registry = createBuiltinEngineRegistry({
		onNotice: options.onNotice,
		...(options.skillPaths ? { skillPaths: options.skillPaths } : {}),
		onLog: (text) => options.onLog(text),
		...(options.thinkCount ? { thinkCount: options.thinkCount } : {}),
		codex: { client: codexClient, bin: options.codexBin, subagentPolicy: codexSubagentPolicy },
		dsh: { client: dshClient, bin: options.dshBin, model: defaultModel },
		opencode: {
			client: opencodeClient,
			bin: options.opencodeBin,
			args: options.opencodeArgs,
			model: options.opencodeModel ?? null,
		},
		claude: {
			client: claudeClient,
			bin: options.claudeBin || undefined,
			args: options.claudeArgs,
			model: options.claudeModel ?? null,
		},
	});

	const catalog = createEngineCatalog({
		registry,
		sessions: {
			pi: options.piSessions,
			// fake 是「剧本回放」引擎：历史沿用 pi 的存储（本地演练 / 冒烟时侧栏不至于全空）
			fake: options.piSessions,
			codex: createCodexSessionsProvider({ client: codexClient, log: (text) => options.onLog(text) }),
			// dsh 的历史会话清单：读 ~/.dsh 的 workspace.json + 会话投影缓存（只读）
			dsh: createDshSessionsProvider({ home: options.dshHome ?? undefined, log: (text) => options.onLog(text) }),
			// opencode 的历史会话清单：按项目 cwd 逐个 `session/list`（接口是项目作用域的）
			opencode: createOpencodeSessionsProvider({
				client: opencodeClient,
				workspaces: opencodeWorkspaces,
				log: (text) => options.onLog(text),
			}),
			// claude 的历史会话清单：直接读 `~/.claude/projects/*/*.jsonl`（标题/时间/模型都在文件里）
			claude: createClaudeSessionsProvider({ log: (text) => options.onLog(text) }),
		},
	});

	const resolved = registry.resolve(options.engineName);
	if (resolved.fallbackFrom) {
		options.onLog(`AGENT_WEB_ENGINE 未注册，回落到 pi（可选：${registry.names().join(" / ")}）`, {
			requested: resolved.fallbackFrom,
		});
	}

	return {
		registry,
		catalog,
		resolved,
		codexClient,
		// 收掉外部引擎的子进程；pi 是进程内 SDK，不需要额外收
		close: () => {
			codexClient.close();
			dshClient.close();
			opencodeClient.close();
			claudeClient.close();
		},
	};
}
