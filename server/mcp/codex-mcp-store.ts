/**
 * codex 的 MCP 后端：**读 codex 自己的配置**（`~/.codex/config.toml` 的 `[mcp_servers.*]`），
 * 写也写回它 —— 面板里看到的就是 `codex mcp list` 那一份，切到 codex 引擎不会再显示 pi 的 mcp.json。
 *
 * 为什么不自己解析 TOML：
 *   - codex 的 app-server 已经把配置和运行状态都摊开了：
 *       `config/read`            → `mcp_servers`（生效值，含默认值合并）
 *       `mcpServerStatus/list`   → 每台的运行状态、`serverInfo`、`tools[]`、`pluginId`
 *       `config/value/write`     → 按 keyPath 写回（atomically 落 config.toml）
 *     自己写一个 TOML 编辑器既要保留注释/缩进，又要处理 profile 与 `-c` 覆盖，徒增风险；
 *   - 写回配置的路径和 codex 自己改配置是同一条，所以「面板改了」=「`codex mcp list` 里也变了」。
 *
 * 能力的真实边界（不是不想做，是 codex 没有这些概念）：
 *   - 没有 pi 的「暴露方式」（codemode / deferred）：`can.expose = false`；
 *   - 没有 `pi mcp login` 那套 OAuth 面板：`can.login = false`（远程服务器用 `bearer_token_env_var`）；
 *   - 「测试连接」不做：`mcpServerStatus/list` 已经把工具和握手结果给了（见每行的 note），
 *     再起一个子进程跑 `npx -y …` 只是慢一倍。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexClient } from "../engine/codex-transport.js";
import { NO_MCP_CAN, engineMcpView, engineServerInfo, parseAddInput, unsupported } from "./mcp-engine-shared.js";
import type { McpResult, McpServerInfo, McpStore } from "./mcp-store.js";

/** `config/read` 里我们用到的那几项（其余字段不认，也不为它写类型） */
type CodexMcpServer = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	bearer_token_env_var?: string;
	http_headers?: Record<string, string>;
	http_headers_env_var?: Record<string, string>;
	enabled?: boolean;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	description?: string;
};

type CodexMcpStatus = {
	name?: string;
	pluginId?: string | null;
	runtimeStatus?: unknown;
	serverInfo?: { name?: string; version?: string } | null;
	tools?: Record<string, { name?: string; description?: string }>;
};

/** codex 的配置目录（与 `CODEX_HOME` 一致；wiring 也是拿这个起 app-server 的） */
export function codexConfigPath(home?: string | null): string {
	return join(home?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
}

export function createCodexMcpStore(options: {
	client: CodexClient;
	/** AGENT_WEB_CODEX_HOME / 默认 ~/.codex */
	home?: string | null;
	log?: (text: string) => void;
}): McpStore {
	const { client } = options;
	const configPath = codexConfigPath(options.home);
	const engine = "codex";
	const can = { ...NO_MCP_CAN, add: true, remove: true, toggle: true };

	const readConfig = async (): Promise<Record<string, CodexMcpServer>> => {
		const result = await client.request<{ config?: { mcp_servers?: Record<string, CodexMcpServer> } }>(
			"config/read",
			{ includeLayers: false },
			{ timeoutMs: 20_000 },
		);
		return result?.config?.mcp_servers ?? {};
	};

	/** 运行状态（可选）：拿不到就当没有，不影响列表 */
	const readStatus = async (): Promise<Map<string, CodexMcpStatus>> => {
		const out = new Map<string, CodexMcpStatus>();
		try {
			const result = await client.request<{ data?: CodexMcpStatus[] }>(
				"mcpServerStatus/list",
				{},
				{ timeoutMs: 25_000 },
			);
			for (const entry of result?.data ?? []) {
				if (typeof entry.name === "string") out.set(entry.name, entry);
			}
		} catch (error) {
			options.log?.(
				`codex：读 MCP 运行状态失败（列表仍可用）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return out;
	};

	const serversOf = async (): Promise<{ servers: McpServerInfo[]; errors: string[] }> => {
		const [config, status] = await Promise.all([readConfig(), readStatus()]);
		const servers: McpServerInfo[] = [];
		for (const [name, raw] of Object.entries(config)) {
			const live = status.get(name);
			const tools = Object.values(live?.tools ?? {}).map((tool) => ({
				name: tool.name ?? "",
				...(typeof tool.description === "string" ? { description: tool.description } : {}),
			}));
			const headers = { ...raw.http_headers, ...raw.http_headers_env_var };
			const note = [
				live?.pluginId ? `由插件 ${live.pluginId} 带来` : null,
				raw.bearer_token_env_var ? `Bearer token 读 ${raw.bearer_token_env_var}` : null,
				tools.length > 0 ? `已连上，${tools.length} 个工具` : null,
			]
				.filter((item): item is string => item !== null)
				.join(" · ");
			servers.push(
				engineServerInfo({
					name,
					scope: "global",
					source: configPath,
					transport: raw.url ? "http" : "stdio",
					enabled: raw.enabled !== false,
					command: raw.url ? undefined : (raw.command ?? ""),
					args: raw.url ? undefined : (raw.args ?? []),
					env: raw.env,
					url: raw.url,
					headers: Object.keys(headers).length > 0 ? headers : undefined,
					description: raw.description,
					timeout: raw.tool_timeout_sec ?? raw.startup_timeout_sec ?? 0,
					...(note ? { note } : {}),
					...(tools.length > 0 ? { tools } : {}),
				}),
			);
		}
		return { servers, errors: [] };
	};

	const view = async (): Promise<McpResult> => {
		try {
			const { servers, errors } = await serversOf();
			return engineMcpView({
				engine,
				source: `Codex · ${configPath}`,
				servers,
				globalPath: configPath,
				can,
				errors,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return engineMcpView({
				engine,
				source: `Codex · ${configPath}`,
				servers: [],
				globalPath: configPath,
				can,
				errors: [`读不到 codex 的 MCP 配置：${message}`],
			});
		}
	};

	const write = async (keyPath: string, value: unknown, mergeStrategy: "replace" | "upsert"): Promise<void> => {
		await client.request(
			"config/value/write",
			{ keyPath, value, mergeStrategy },
			// 写盘要在 app-server 里排队等它自己 reload，慢一点是正常的
			{ timeoutMs: 30_000 },
		);
	};

	return {
		view: async () => view(),

		async act(input) {
			const base = await view();
			try {
				if (input.action === "add") {
					const parsed = parseAddInput({
						text: input.text,
						command: input.command,
						url: input.url,
						description: input.description,
						taken: base.servers.map((server) => server.name),
					});
					if ("error" in parsed) return { ...base, actionError: parsed.error };
					const config = parsed.config;
					const value = config.url
						? { url: config.url, ...(config.headers ? { http_headers: config.headers } : {}) }
						: {
								command: config.command ?? "",
								args: config.args ?? [],
								...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
								...(config.cwd ? { cwd: config.cwd } : {}),
							};
					await write(`mcp_servers.${parsed.name}`, value, "upsert");
					return { ...(await view()), notice: `已写入 codex：mcp_servers.${parsed.name}`, added: [parsed.name] };
				}
				if (input.action === "remove") {
					if (!input.name) return { ...base, actionError: "要删哪一台？" };
					await write(`mcp_servers.${input.name}`, null, "replace");
					return { ...(await view()), notice: `已从 codex 配置里移除 ${input.name}` };
				}
				if (input.action === "set-enabled") {
					if (!input.name) return { ...base, actionError: "要改哪一台？" };
					await write(`mcp_servers.${input.name}.enabled`, input.enabled === true, "replace");
					return { ...(await view()), notice: `${input.name}：${input.enabled === true ? "启用" : "停用"}` };
				}
				if (input.action === "parse") {
					const parsed = parseAddInput({
						text: input.text,
						command: input.command,
						url: input.url,
						description: input.description,
						taken: base.servers.map((server) => server.name),
					});
					if ("error" in parsed) return { ...base, actionError: parsed.error };
					return {
						...base,
						preview: [parsed],
						notes: [`将写入 ${configPath} 的 [mcp_servers.${parsed.name}]`],
					};
				}
				return { ...base, actionError: unsupported(actionLabel(input.action), "codex") };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.log?.(`codex：MCP 操作失败（${input.action}）：${message}`);
				return { ...base, actionError: `codex 拒绝了这次操作：${message}` };
			}
		},
	};
}

function actionLabel(action: string): string {
	const labels: Record<string, string> = {
		"set-exposure": "改暴露方式",
		"set-scope-enabled": "按作用域启停",
		test: "测试连接",
		login: "OAuth 登录",
		"login-status": "查登录状态",
		"login-cancel": "取消登录",
	};
	return labels[action] ?? action;
}
