/**
 * MCP 服务器面板的数据层：读 → 合并 → 展示；改启停 / 暴露方式；增删；**真连一次**看工具。
 *
 * 与「插件」面板同一套纪律：
 *   - **按需查**，走 HTTP 不进快照（服务器清单不是会话状态，塞进每一帧只会让所有客户端一直驼着）；
 *   - **配置就是真相**：显示的就是会话启动时 pi 会去连的东西，面板不另存一份；
 *   - **改配置对新会话生效**：已经开着的会话在启动时就把 MCP 连上了。
 *
 * 「测试连接」是本面板唯一主动做的事：它按配置真起一个 stdio / HTTP 连接，握手 + `tools/list`，
 * 然后立刻关掉。用的是 pi 自己那份客户端（`@earendil-works/pi-mcp`），所以协议版本、
 * 请求头（`Accept: application/json, text/event-stream`）这些细节跟运行时完全一致 ——
 * 自己手搓一份 JSON-RPC 只会在「面板说通了、会话却连不上」时给人添堵。
 */
import { readAccessToken, readAuthState, type McpAuthState, type McpLogin, type McpLoginState } from "./mcp-auth.js";
import { probeServer, PROBE_TIMEOUT_SEC } from "./mcp-probe.js";
import { deriveServerName, sanitizeServerName, uniqueName } from "./mcp-command.js";
import { parseMcpPaste, type ParsedMcpServer } from "./mcp-import.js";
import {
	DEFAULT_EXPOSURE,
	addMcpServerConfig,
	globalMcpPath,
	loadMcpConfig,
	projectMcpPath,
	removeMcpServerConfig,
	updateMcpServerConfig,
	validateMcpServerConfig,
	type McpExposure,
	type McpScope,
	type McpServerConfig,
	type McpServerEntry,
} from "./pi-mcp-config.js";

type McpEnvRef = {
	/** 配置里的键（环境变量名 / 请求头名） */
	key: string;
	/** 值里引用的宿主机环境变量 */
	variable: string;
	/** 这台机器上有没有这个变量 */
	present: boolean;
};

type McpToolInfo = { name: string; description?: string };

/** 一次连接的实测结果（面板里的「状态」那一行） */
export type McpProbeResult = {
	ok: boolean;
	/** 什么时候测的（毫秒时间戳） */
	at: number;
	ms: number;
	tools: McpToolInfo[];
	serverName?: string;
	serverVersion?: string;
	protocolVersion?: string;
	error?: string;
	/** 失败时 stdio 子进程的 stderr 尾巴（大多数连不上都写在这里） */
	stderr?: string;
};

export type McpServerInfo = {
	name: string;
	scope: McpScope;
	/** 定义它的文件 */
	source: string;
	/** 项目文件覆盖全局时 = 覆盖文件的路径 */
	override?: string;
	enabled: boolean;
	exposure: McpExposure;
	description?: string;
	timeout: number;
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	toolExposure?: Record<string, McpExposure>;
	/** 环境变量 / 请求头里引用的宿主机变量，以及本机有没有 */
	envRefs: McpEnvRef[];
	/** pi 那边存过这张服务器的 OAuth 凭据吗（`mcp-auth.json`） */
	auth?: McpAuthState;
	/** 面板显示过一次测试结果就带上 */
	probe?: McpProbeResult;
	/**
	 * 引擎侧的一句话说明（非 pi 引擎用）：codex 的运行状态 / 由哪个插件带来、
	 * claude 的传输类型、opencode 的 local/remote……
	 * pi 不填（它的信息都在上面那些字段里）。
	 */
	note?: string;
	/** 引擎已经报上来的工具清单（codex 的 `mcpServerStatus/list` 直接给，不用再连一次） */
	tools?: McpToolInfo[];
};

export type McpView = {
	servers: McpServerInfo[];
	globalPath: string;
	projectPath: string;
	/** 项目那一份文件到底存不存在（不存在就不用画「项目」分组） */
	projectExists: boolean;
	/** 配置层面的错误（坏 JSON、非法条目…）。坏条目照样列出来，错误单独给 */
	errors: string[];
	/** 代码模式会不会自动打开（默认会） */
	autoEnableCodemode: boolean;
	enabled: number;
	total: number;
	/**
	 * 这份数据属于哪个引擎（切引擎 = 换口径）。
	 * pi 不填（保持旧行为）；非 pi 引擎必填 —— 面板据此画「现在改的是谁的文件」。
	 */
	engine?: string;
	/** 人话源头（面板顶部那行）：`Codex · ~/.codex/config.toml` */
	source?: string;
	/** 这个引擎允许面板做哪些动作（不支持的按钮隐藏，而不是点了报错） */
	can?: {
		add: boolean;
		remove: boolean;
		toggle: boolean;
		test: boolean;
		expose: boolean;
		login: boolean;
	};
};

export type McpAction =
	| "add"
	/** 试解析：只把粘贴内容翻成配置看一眼，不写文件（添加框里的实时预览） */
	| "parse"
	| "remove"
	| "set-enabled"
	| "set-exposure"
	| "set-scope-enabled"
	| "test"
	/** OAuth：起一次 `pi mcp login <name>`，把授权地址交给界面 */
	| "login"
	/** 轮询那次登录的状态（界面上「等待授权…」） */
	| "login-status"
	| "login-cancel";

export type McpResult = McpView & {
	actionError?: string;
	notice?: string;
	/** test 动作的结果（也就是刚测的那一条） */
	probe?: McpProbeResult;
	/** parse（试解析）的结果：添加框里那行「会存成什么」 */
	preview?: ParsedMcpServer[];
	/** parse 给出的提示：改名了、丢了哪些字段、需要补哪个环境变量 */
	notes?: string[];
	/** 刚添加成功的服务器名（界面据此把新加的那台选上，不用再去左边找） */
	added?: string[];
	/** login / login-status 的状态 */
	login?: McpLoginState;
};

export type McpStore = {
	view: (workspace: string) => Promise<McpResult>;
	act: (input: {
		workspace: string;
		action: McpAction;
		name?: string;
		scope?: McpScope;
		enabled?: boolean;
		exposure?: McpExposure;
		/** add 用：粘进来的那一整段（URL / 命令行 / 各家 CLI / JSON），见 mcp-import.ts */
		text?: string;
		/** add 用：市场给的那一条（已经拼好的 config），与 text 二选一 */
		config?: McpServerConfig;
		/** add 用：命令行的两段式写法（旧的表单字段，保留兼容） */
		command?: string;
		url?: string;
		description?: string;
	}) => Promise<McpResult>;
};

// ---------------------------------------------------------------------------
// 值里的宿主机变量（pi 的规矩：`${NAME}` 取环境变量，`!cmd` 跑命令取 stdout）
// ---------------------------------------------------------------------------

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function refsOf(key: string, raw: string): McpEnvRef[] {
	const refs: McpEnvRef[] = [];
	for (const match of raw.matchAll(ENV_REF)) {
		const variable = match[1]!;
		refs.push({ key, variable, present: process.env[variable] !== undefined });
	}
	return refs;
}

/** 值是不是「整条命令」（`!cmd`），面板上要标出来免得人以为填错了 */
export function isCommandValue(raw: string): boolean {
	return raw.startsWith("!");
}

/** 只保留尾部：stderr 常常几十行，面板只放得下一屏 */
function toInfo(entry: McpServerEntry, probe?: McpProbeResult): McpServerInfo {
	const { config } = entry;
	const env = config.env;
	const headers = config.headers;
	const envRefs: McpEnvRef[] = [];
	for (const [key, value] of Object.entries(env ?? {})) envRefs.push(...refsOf(key, value));
	for (const [key, value] of Object.entries(headers ?? {})) envRefs.push(...refsOf(key, value));
	return {
		name: entry.name,
		scope: entry.scope,
		source: entry.source,
		...(entry.override === undefined ? {} : { override: entry.override }),
		enabled: config.enabled !== false,
		exposure: config.exposure ?? DEFAULT_EXPOSURE,
		...(config.description === undefined ? {} : { description: config.description }),
		timeout: config.timeout ?? PROBE_TIMEOUT_SEC,
		transport: config.url !== undefined ? "http" : "stdio",
		...(config.command === undefined ? {} : { command: config.command }),
		...(config.args === undefined ? {} : { args: config.args }),
		...(config.cwd === undefined ? {} : { cwd: config.cwd }),
		...(env === undefined ? {} : { env }),
		...(config.url === undefined ? {} : { url: config.url }),
		...(headers === undefined ? {} : { headers }),
		...(config.toolExposure === undefined ? {} : { toolExposure: config.toolExposure }),
		envRefs,
		...(probe === undefined ? {} : { probe }),
	};
}

// 增删改
// ---------------------------------------------------------------------------

/**
 * 一次「添加」的三种来源归一到同一个结果：
 *   - `text`：用户在添加框里粘的一整段（URL / 命令行 / 各家 CLI / JSON），交给 `parseMcpPaste`；
 *   - `config`：市场卡片给的那一条（已经拼好的 config），只补个名字；
 *   - `command` / `url`：最早的两种单行字段，留着兼容（面板上的旧调用点）。
 * 名字为空时按命令 / 地址猜，撞名则加序号——**绝不静默覆盖**已有配置。
 */
function parseAddInput(
	input: Parameters<McpStore["act"]>[0],
	taken: string[],
): { servers: ParsedMcpServer[]; notes?: string[]; error?: string } {
	if (input.config !== undefined) {
		const raw = input.name?.trim() ?? "";
		const base =
			raw === ""
				? deriveServerName(input.config.url ?? [input.config.command ?? "", ...(input.config.args ?? [])].join(" "))
				: raw;
		const name = uniqueName(sanitizeServerName(base), taken);
		// 市场卡片的简介顺手写进配置：面板上那句话本来就是「给模型看的一句话」
		const description = input.config.description ?? input.description;
		const config: McpServerConfig = description ? { ...input.config, description } : input.config;
		return { servers: [{ name, config }] };
	}
	if (input.text !== undefined && input.text.trim() !== "") {
		return parseMcpPaste(input.text, taken);
	}
	const raw = (input.command ?? input.url ?? "").trim();
	if (raw === "") return { servers: [], error: "还没填内容：粘一条命令、一个地址，或者一段 mcpServers 配置" };
	return parseMcpPaste(raw, taken);
}

/** 连接失败是不是「没登录」（pi 的客户端把 401 统一报成这句话） */
export function needsLogin(error: string | undefined): boolean {
	if (error === undefined) return false;
	return /requires authentication|unauthori[sz]ed|invalid_token|\b401\b/i.test(error);
}

export function createMcpStore(options: { agentDir: string; login: McpLogin }): McpStore {
	const { agentDir, login } = options;
	/** 最近一次连接测试的结果：只活在这个进程里（重启后重测，别把旧结论当现状） */
	const probes = new Map<string, McpProbeResult>();
	/** 同一个服务器的测试串起来做：两次点击同时起两个 npx 只会互相拖慢 */
	const running = new Map<string, Promise<McpProbeResult>>();
	// key 里带上工作区：同一个名字在另一个项目里可能被覆盖成另一份配置，
	// 拿着 A 项目的「连得上」去回答 B 项目就是在撒谎
	const keyOf = (workspace: string, scope: McpScope, name: string) => `${workspace}\0${scope}\0${name}`;

	async function readView(workspace: string): Promise<McpResult> {
		const loaded = loadMcpConfig({ agentDir, workspace });
		const servers = loaded.servers
			.map((entry) => {
				const info = toInfo(entry, probes.get(keyOf(workspace, entry.scope, entry.name)));
				// 只有 HTTP 服务器会走 OAuth；stdio 的凭据在它自己的环境变量里
				if (entry.config.url === undefined) return info;
				const auth = readAuthState(agentDir, entry.name, entry.config.url);
				return auth.present ? { ...info, auth } : info;
			})
			// 项目的排前面：改配置的人多数是在这个项目里干活
			.sort((left, right) =>
				left.scope === right.scope ? left.name.localeCompare(right.name) : left.scope === "project" ? -1 : 1,
			);
		return {
			servers,
			globalPath: globalMcpPath(agentDir),
			projectPath: loaded.projectConfig ?? projectMcpPath(workspace),
			projectExists: loaded.projectConfig !== undefined,
			errors: loaded.errors,
			autoEnableCodemode: loaded.autoEnableCodemode !== false,
			enabled: servers.filter((server) => server.enabled).length,
			total: servers.length,
		};
	}

	/** 找一条配置；找不到就说清楚（面板可能停在旧列表上） */
	function find(workspace: string, scope: McpScope, name: string): McpServerEntry | undefined {
		return loadMcpConfig({ agentDir, workspace }).servers.find((entry) => entry.name === name && entry.scope === scope);
	}

	async function act(input: Parameters<McpStore["act"]>[0]): Promise<McpResult> {
		const { workspace, action } = input;
		const scope: McpScope = input.scope === "project" ? "project" : "global";
		const name = (input.name ?? "").trim();
		let actionError: string | undefined;
		let notice: string | undefined;
		let probe: McpProbeResult | undefined;
		let preview: ParsedMcpServer[] | undefined;
		let notes: string[] | undefined;
		let addedNames: string[] | undefined;
		let loginState: McpLoginState | undefined;
		const path = scope === "project" ? projectMcpPath(workspace) : globalMcpPath(agentDir);

		try {
			if (action === "add" || action === "parse") {
				// 已经有名字先占着：避免「粘两条同名的」互相覆盖（parse 也要按同一个口径预览）
				const taken = loadMcpConfig({ agentDir, workspace })
					.servers.filter((entry) => entry.scope === scope)
					.map((entry) => entry.name);
				const parsed = parseAddInput(input, taken);
				notes = parsed.notes;
				preview = parsed.servers;
				if (parsed.error !== undefined) throw new Error(parsed.error);
				if (action === "parse") return { ...(await readView(workspace)), notes, preview };

				const added: string[] = [];
				for (const server of parsed.servers) {
					const valid = validateMcpServerConfig(server.name, server.config);
					if (typeof valid === "string") throw new Error(valid);
					addMcpServerConfig(path, server.name, valid);
					added.push(server.name);
				}
				addedNames = added;
				notice =
					added.length === 1
						? `已添加 "${added[0]}"（对新会话生效）`
						: `已添加 ${added.length} 个服务器：${added.join("、")}（对新会话生效）`;
			} else if (action === "remove") {
				const entry = find(workspace, scope, name);
				if (!entry) throw new Error(`找不到服务器 "${name}"（刷新一下再看）`);
				// 定义在哪份文件就从哪份删；项目覆盖项删掉后，全局那条会重新生效
				const removed = removeMcpServerConfig(entry.override ?? entry.source, entry.name);
				probes.delete(keyOf(workspace, scope, name));
				if (!removed) throw new Error(`"${name}" 已经不在配置里了（刷新一下再看）`);
				notice =
					entry.override === undefined
						? `已移除 "${name}"（对新会话生效）`
						: `已移除本项目的覆盖项，"${name}" 回到全局配置（对新会话生效）`;
			} else if (action === "set-enabled") {
				const entry = find(workspace, scope, name);
				if (!entry) throw new Error(`找不到服务器 "${name}"（刷新一下再看）`);
				const enabled = input.enabled !== false;
				// 有项目覆盖项就改覆盖项：pi 的 `/mcp` 也是这么存「本项目里先关掉」
				updateMcpServerConfig(
					entry.override ?? entry.source,
					entry.name,
					{ enabled },
					{ override: entry.override !== undefined },
				);
				notice = enabled ? `已启用 "${entry.name}"（对新会话生效）` : `已停用 "${entry.name}"（对新会话生效）`;
			} else if (action === "set-scope-enabled") {
				const enabled = input.enabled !== false;
				const targets = loadMcpConfig({ agentDir, workspace }).servers.filter((entry) => entry.scope === scope);
				for (const entry of targets) {
					updateMcpServerConfig(
						entry.override ?? entry.source,
						entry.name,
						{ enabled },
						{ override: entry.override !== undefined },
					);
				}
				notice = `${scope === "project" ? "项目" : "全局"}的 ${targets.length} 个服务器已${enabled ? "启用" : "停用"}（对新会话生效）`;
			} else if (action === "set-exposure") {
				const entry = find(workspace, scope, name);
				if (!entry) throw new Error(`找不到服务器 "${name}"（刷新一下再看）`);
				const exposure = input.exposure ?? DEFAULT_EXPOSURE;
				updateMcpServerConfig(
					entry.override ?? entry.source,
					entry.name,
					{ exposure },
					{ override: entry.override !== undefined },
				);
				notice = `"${entry.name}" 的工具改成 ${exposure}（对新会话生效）`;
			} else if (action === "login" || action === "login-status" || action === "login-cancel") {
				const entry = find(workspace, scope, name);
				if (!entry) throw new Error(`找不到服务器 "${name}"（刷新一下再看）`);
				if (entry.config.url === undefined) throw new Error("只有 HTTP 服务器需要登录授权（stdio 的凭据走环境变量）");
				if (action === "login") {
					loginState = await login.start(entry.name);
					notice = loginState.url === undefined ? "正在准备授权…" : "请在浏览器里完成授权（链接在下面）";
					if (loginState.status === "failed") actionError = loginState.message ?? "登录没起来";
					// 登录会写 pi 的 mcp-auth.json，登录完成后再测一次才有意义
					probes.delete(keyOf(workspace, scope, entry.name));
				} else if (action === "login-status") {
					loginState = login.status(entry.name) ?? undefined;
					if (loginState?.status === "done") {
						probes.delete(keyOf(workspace, scope, entry.name));
						notice = `"${entry.name}" 已登录，点「测试连接」确认一下`;
					} else if (loginState?.status === "failed") {
						actionError = loginState.message ?? "登录失败";
					}
				} else {
					login.cancel(entry.name);
					loginState = login.status(entry.name) ?? undefined;
					notice = "已取消登录";
				}
			} else if (action === "test") {
				const entry = find(workspace, scope, name);
				if (!entry) throw new Error(`找不到服务器 "${name}"（刷新一下再看）`);
				const key = keyOf(workspace, scope, name);
				const existing = running.get(key);
				const timeoutSec = entry.config.timeout ?? PROBE_TIMEOUT_SEC;
				const token =
					entry.config.url === undefined ? undefined : readAccessToken(agentDir, entry.name, entry.config.url);
				const pending = existing ?? probeServer(entry, workspace, timeoutSec, token);
				if (!existing) running.set(key, pending);
				try {
					probe = await pending;
				} finally {
					running.delete(key);
				}
				probes.set(key, probe);
				notice = probe.ok
					? `连上了：${probe.tools.length} 个工具`
					: needsLogin(probe.error)
						? "这台服务器要登录授权：点上面的「登录」，在浏览器里授权完再测"
						: "连不上，看下面的报错";
			}
		} catch (error) {
			actionError = error instanceof Error ? error.message : String(error);
		}

		return {
			...(await readView(workspace)),
			actionError,
			notice,
			...(probe === undefined ? {} : { probe }),
			...(preview === undefined ? {} : { preview }),
			...(notes === undefined ? {} : { notes }),
			...(addedNames === undefined ? {} : { added: addedNames }),
			...(loginState === undefined ? {} : { login: loginState }),
		};
	}

	return { view: readView, act };
}
