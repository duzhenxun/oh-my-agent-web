/**
 * 「非 pi 引擎」的 MCP 面板后端要用的公共件：视图形状、粘贴解析、能力位。
 *
 * ADR-0045：面板跟着当前引擎走 —— 「模型 / 插件 / MCP」三块都读当前引擎自己的东西。
 *
 * 背景（这次要修的事）：MCP 面板以前只认 pi 的 `mcp.json`，切到 codex / claude 之后
 * 面板里还是 pi 的那份配置 —— 看起来「什么都没变」，其实是在改错文件。
 * 所以每个引擎各给一个 store（`McpStore` 是同一套接口，见 mcp-store.ts），
 * 由路由按**当前引擎**选；面板顶部因此永远能说清「现在改的是谁的文件」。
 *
 * 能力位 `can`：面板只画得出来的动作（不支持的就隐藏，而不是点了报一句看不懂的错）。
 * 三个引擎的真实差异就是这张表：
 *   - codex：增删启停都能通过 app-server 的 `config/value/write` 落地，但没有 pi 的
 *     「暴露方式」（codemode / deferred）、也没有 `pi mcp login` 那套 OAuth；
 *   - claude：`~/.claude.json`（用户级）/ `<ws>/.mcp.json`（项目级），只有增删；
 *   - opencode：`opencode.json` 的 `mcp`，增删 + 启停（它自己有 `enabled`）；
 *   - dsh：没接（空视图 + 一句说明）。
 */
import { parseMcpPaste } from "./mcp-import.js";
import type { McpServerConfig, McpScope } from "./pi-mcp-config.js";
import type { McpResult, McpServerInfo, McpView } from "./mcp-store.js";

/** 面板允许的动作（缺省全 false：宁可少画一个按钮，也不要点了假成功） */
type EngineMcpCan = {
	add: boolean;
	remove: boolean;
	toggle: boolean;
	/** 真连一次看工具（目前只有 pi 有；别的引擎靠 `mcpServerStatus/list` 或干脆不给） */
	test: boolean;
	/** pi 的「暴露方式」（codemode / deferred / direct / hidden） */
	expose: boolean;
	/** `pi mcp login` 那套 OAuth */
	login: boolean;
};

export const NO_MCP_CAN: EngineMcpCan = {
	add: false,
	remove: false,
	toggle: false,
	test: false,
	expose: false,
	login: false,
};

/** 统一的视图收口：把引擎自己的服务器表拼成面板认的那份形状 */
export function engineMcpView(input: {
	engine: string;
	/** 人话来源（面板顶部那行：「Codex · ~/.codex/config.toml」） */
	source: string;
	servers: McpServerInfo[];
	globalPath: string;
	projectPath?: string;
	can: EngineMcpCan;
	errors?: string[];
}): McpResult {
	const servers = [...input.servers].sort((left, right) => left.name.localeCompare(right.name));
	const view: McpView = {
		servers,
		globalPath: input.globalPath,
		projectPath: input.projectPath ?? "",
		projectExists: (input.projectPath ?? "") !== "" && servers.some((server) => server.scope === "project"),
		errors: input.errors ?? [],
		// 代码模式是 pi 的概念：别的引擎没有，给 false 而不是假装开着
		autoEnableCodemode: false,
		enabled: servers.filter((server) => server.enabled).length,
		total: servers.length,
		engine: input.engine,
		source: input.source,
		can: input.can,
	};
	return view;
}

/**
 * 面板的「添加」入参 → 规范条目。
 *
 * 复用 pi 那套粘贴解析（`parseMcpPaste` 认 JSON / 裸 URL / 各家 CLI 命令），
 * 因为「用户粘一段就完事」这件事跟引擎无关；差别只在写回哪个文件。
 */
export function parseAddInput(input: {
	text?: string;
	command?: string;
	url?: string;
	description?: string;
	taken?: string[];
}): { name: string; config: McpServerConfig } | { error: string } {
	const text = (input.text ?? "").trim() || (input.url ?? "").trim() || (input.command ?? "").trim();
	if (text === "") return { error: "还没填内容" };
	const parsed = parseMcpPaste(text, input.taken ?? []);
	if (parsed.error) return { error: parsed.error };
	const first = parsed.servers[0];
	if (!first) return { error: "没解析出 MCP 服务器" };
	return {
		name: first.name,
		config: input.description ? { ...first.config, description: input.description } : first.config,
	};
}

/** 一行服务器的公共外壳（三个引擎的字段各写各的，外壳一样） */
export function engineServerInfo(input: {
	name: string;
	scope: McpScope;
	source: string;
	transport: "stdio" | "http";
	enabled: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	timeout?: number;
	/** 引擎侧的运行状态 / 来源说明（codex 的 runtimeStatus、plugin 来源…） */
	note?: string;
	tools?: { name: string; description?: string }[];
}): McpServerInfo {
	return {
		name: input.name,
		scope: input.scope,
		source: input.source,
		enabled: input.enabled,
		// 「暴露方式」是 pi 独有的：别的引擎一律 direct（面板不画那个控件）
		exposure: "direct",
		timeout: input.timeout ?? 0,
		transport: input.transport,
		...(input.command ? { command: input.command } : {}),
		...(input.args ? { args: input.args } : {}),
		...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
		...(input.url ? { url: input.url } : {}),
		...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
		...(input.description ? { description: input.description } : {}),
		...(input.note ? { note: input.note } : {}),
		...(input.tools ? { tools: input.tools } : {}),
		// 环境变量引用照旧算出来：界面要提示「本机有没有这个变量」
		envRefs: envRefsOf({ ...input.env, ...input.headers }),
	};
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Z_][A-Z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 值里引用的宿主机变量（三种写法都认：pi 的 `${X}`、codex 的 `$X`、claude 的 `{env:X}`） */
function envRefsOf(values: Record<string, string>): { key: string; variable: string; present: boolean }[] {
	const refs: { key: string; variable: string; present: boolean }[] = [];
	for (const [key, raw] of Object.entries(values)) {
		if (typeof raw !== "string") continue;
		for (const match of raw.matchAll(ENV_REF)) {
			const variable = match[1] ?? match[3] ?? match[4];
			if (!variable) continue;
			if (refs.some((ref) => ref.key === key && ref.variable === variable)) continue;
			refs.push({ key, variable, present: process.env[variable] !== undefined });
		}
	}
	return refs;
}

/** 「当前引擎不支持这个动作」的统一样式：不抛错（否则列表也会跟着空） */
export function unsupported(name: string, engine: string): string {
	return `${engine} 引擎不支持在面板里做「${name}」：配置已经写在它自己的文件里，改文件或在它的 CLI 里操作`;
}
