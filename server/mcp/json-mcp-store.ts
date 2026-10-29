/**
 * 「配置文件就是一份 JSON」的引擎共用的 MCP 后端：claude 与 opencode 都走这里。
 *
 * 为什么能共用：这两家的 MCP 配置都是**一个 JSON 文件里的一张表**
 * （claude：`~/.claude.json` / `<ws>/.mcp.json` 的 `mcpServers`；
 *  opencode：`~/.config/opencode/opencode.json` / `<ws>/opencode.json` 的 `mcp`），
 * 差别只有「表叫什么、每台怎么写」—— 抽成 `JsonMcpShape` 之后剩下的逻辑完全一致：
 * 读文件 → 取出表 → 转成面板形状；改 = 读文件 → 改表 → 原子写回（其余字段原样保留）。
 *
 * 两条纪律（写用户自己的配置文件，必须保守）：
 *   1. **只碰我们那一层**：根对象、以及那张表里的目标键；其它键（主题、模型、provider…）一律原样写回；
 *   2. **坏文件不硬修**：parse 失败就报错让人自己看，绝不「重写成一个干净的 JSON」——
 *      那会把用户手写的注释外的全部历史吞掉（`~/.claude.json` 有几十个字段）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonObject, tableOf, writeJsonObject, type JsonObject as Json } from "../util/json-file.js";
import type { McpServerConfig } from "./pi-mcp-config.js";
import { NO_MCP_CAN, engineMcpView, engineServerInfo, parseAddInput, unsupported } from "./mcp-engine-shared.js";
import type { McpResult, McpServerInfo, McpStore } from "./mcp-store.js";

type JsonMcpShape = {
	/** 配置文件里的那张表叫什么（`mcpServers` / `mcp`） */
	table: string;
	/** 表里的一条 → 面板形状；认不出就返回 null（不认识的条目跳过，不猜） */
	toInfo: (input: { name: string; raw: unknown; source: string; scope: "global" | "project" }) => McpServerInfo | null;
	/** 面板解析出来的配置 → 表里的一条 */
	fromConfig: (config: McpServerConfig) => unknown;
	/** 这台开着吗（默认全开：claude 的 mcpServers 没有 enabled 字段） */
	isEnabled?: (raw: unknown) => boolean;
	/** 改启停（没有 enabled 概念的引擎不提供） */
	withEnabled?: (raw: unknown, enabled: boolean) => unknown;
};

function createJsonMcpStore(options: {
	engine: "claude" | "opencode";
	/** 面板顶部那行的人话前缀（`Claude Code` / `opencode`） */
	label: string;
	globalPath: () => string;
	projectPath: (workspace: string) => string;
	shape: JsonMcpShape;
	can: { add: boolean; remove: boolean; toggle: boolean };
	log?: (text: string) => void;
}): McpStore {
	const { engine, shape } = options;
	const can = { ...NO_MCP_CAN, ...options.can };

	const collect = (workspace: string): { servers: McpServerInfo[]; errors: string[] } => {
		const servers: McpServerInfo[] = [];
		const errors: string[] = [];
		const scopes: Array<{ scope: "global" | "project"; file: string }> = [
			{ scope: "global", file: options.globalPath() },
			{ scope: "project", file: options.projectPath(workspace) },
		];
		for (const { scope, file } of scopes) {
			const read = readJsonObject(file);
			if ("error" in read) {
				// 项目文件不存在是正常的（不建空文件），解析失败才是真错
				if (existsSync(file)) errors.push(read.error);
				continue;
			}
			for (const [name, raw] of Object.entries(tableOf(read.json, shape.table))) {
				const info = shape.toInfo({ name, raw, source: file, scope });
				if (info) servers.push(info);
			}
		}
		return { servers, errors };
	};

	const build = (workspace: string): McpResult => {
		const { servers, errors } = collect(workspace);
		const globalPath = options.globalPath();
		return engineMcpView({
			engine,
			source: `${options.label} · ${globalPath}`,
			servers,
			globalPath,
			projectPath: options.projectPath(workspace),
			can,
			errors,
		});
	};

	/** 改一台：读（global 或 project）→ 改表 → 写回 */
	const mutate = (
		workspace: string,
		scope: "global" | "project",
		name: string,
		change: (table: Record<string, unknown>) => void,
	): { error?: string } => {
		const file = scope === "project" ? options.projectPath(workspace) : options.globalPath();
		const read = readJsonObject(file);
		if ("error" in read) return { error: read.error };
		const table = { ...tableOf(read.json, shape.table) };
		change(table);
		writeJsonObject(file, { ...read.json, [shape.table]: table });
		return {};
	};

	return {
		async view(workspace) {
			return build(workspace);
		},

		async act(input) {
			const base = build(input.workspace);
			const scope = input.scope === "project" ? "project" : "global";
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
					const written = mutate(input.workspace, scope, parsed.name, (table) => {
						table[parsed.name] = shape.fromConfig(parsed.config);
					});
					if (written.error) return { ...base, actionError: written.error };
					return {
						...(await build(input.workspace)),
						notice: `已写入 ${scope === "project" ? options.projectPath(input.workspace) : options.globalPath()}：${parsed.name}`,
						added: [parsed.name],
					};
				}
				if (input.action === "remove") {
					if (!input.name) return { ...base, actionError: "要删哪一台？" };
					const target = base.servers.find((server) => server.name === input.name);
					if (!target) return { ...base, actionError: `找不到 ${input.name}` };
					const name = input.name;
					const written = mutate(input.workspace, target.scope, name, (table) => {
						delete table[name];
					});
					if (written.error) return { ...base, actionError: written.error };
					return { ...(await build(input.workspace)), notice: `已移除 ${input.name}` };
				}
				if (input.action === "set-enabled") {
					if (!shape.withEnabled) return { ...base, actionError: unsupported("启停", engine) };
					if (!input.name) return { ...base, actionError: "要改哪一台？" };
					const target = base.servers.find((server) => server.name === input.name);
					if (!target) return { ...base, actionError: `找不到 ${input.name}` };
					const name = input.name;
					const written = mutate(input.workspace, target.scope, name, (table) => {
						table[name] = shape.withEnabled?.(table[name], input.enabled === true);
					});
					if (written.error) return { ...base, actionError: written.error };
					return {
						...(await build(input.workspace)),
						notice: `${input.name}：${input.enabled === true ? "启用" : "停用"}`,
					};
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
						notes: [`将写入 ${scope === "project" ? options.projectPath(input.workspace) : options.globalPath()}`],
					};
				}
				const labels: Record<string, string> = {
					"set-exposure": "改暴露方式",
					"set-scope-enabled": "按作用域启停",
					test: "测试连接",
					login: "OAuth 登录",
					"login-status": "查登录状态",
					"login-cancel": "取消登录",
				};
				return { ...base, actionError: unsupported(labels[input.action] ?? input.action, engine) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.log?.(`${engine}：MCP 操作失败（${input.action}）：${message}`);
				return { ...base, actionError: message };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Claude Code：`~/.claude.json` 的 mcpServers（用户级）+ `<ws>/.mcp.json`（项目级）
// ---------------------------------------------------------------------------

function claudeConfigPath(home?: string): string {
	// `CLAUDE_CONFIG_DIR` 是**目录**（`~/.claude`），而 `~/.claude.json` 是它旁边那个文件
	const dir = home?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(dirname(dir), `${dir.split("/").pop()}.json`);
}

const claudeShape: JsonMcpShape = {
	table: "mcpServers",
	toInfo({ name, raw, source, scope }) {
		if (raw === null || typeof raw !== "object") return null;
		const entry = raw as Json;
		const url = typeof entry.url === "string" ? entry.url : undefined;
		const headers = (entry.headers ?? {}) as Record<string, string>;
		const env = (entry.env ?? {}) as Record<string, string>;
		const type = typeof entry.type === "string" ? entry.type : undefined;
		return engineServerInfo({
			name,
			scope,
			source,
			transport: url ? "http" : "stdio",
			// Claude 的 mcpServers 没有 enabled 字段：写了就是不关
			enabled: true,
			command: url ? undefined : (entry.command as string | undefined),
			args: url ? undefined : ((entry.args as string[] | undefined) ?? []),
			env,
			url,
			headers,
			note: url ? `Claude Code 远程服务器${type ? `（${type}）` : ""}` : "Claude Code stdio 服务器",
		});
	},
	fromConfig(config) {
		return config.url
			? { type: "http", url: config.url, ...(config.headers ? { headers: config.headers } : {}) }
			: {
					type: "stdio",
					command: config.command ?? "",
					args: config.args ?? [],
					...(config.env ? { env: config.env } : {}),
				};
	},
};

export function createClaudeMcpStore(options: { home?: string; log?: (text: string) => void } = {}): McpStore {
	return createJsonMcpStore({
		engine: "claude",
		label: "Claude Code",
		globalPath: () => claudeConfigPath(options.home),
		projectPath: (workspace) => join(workspace, ".mcp.json"),
		shape: claudeShape,
		// Claude 没有单独的项目级「启用」概念，也没有 enabled 字段 → 只有增删
		can: { add: true, remove: true, toggle: false },
		...(options.log ? { log: options.log } : {}),
	});
}

// ---------------------------------------------------------------------------
// opencode：`~/.config/opencode/opencode.json` 的 mcp（`local` / `remote`）
// ---------------------------------------------------------------------------

function opencodeConfigPath(workspace?: string): string {
	if (workspace) return join(workspace, "opencode.json");
	const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(base, "opencode", "opencode.json");
}

const opencodeShape: JsonMcpShape = {
	table: "mcp",
	toInfo({ name, raw, source, scope }) {
		if (raw === null || typeof raw !== "object") return null;
		const entry = raw as Json;
		const url = typeof entry.url === "string" ? entry.url : undefined;
		const command = Array.isArray(entry.command) ? entry.command.map((item) => String(item)) : [];
		return engineServerInfo({
			name,
			scope,
			source,
			transport: url ? "http" : "stdio",
			enabled: entry.enabled !== false,
			command: url ? undefined : (command[0] ?? ""),
			args: url ? undefined : command.slice(1),
			env: (entry.environment ?? {}) as Record<string, string>,
			url,
			headers: (entry.headers ?? {}) as Record<string, string>,
			note: `opencode ${url ? "remote" : "local"} 服务器`,
		});
	},
	fromConfig(config) {
		return config.url
			? { type: "remote", url: config.url, enabled: true, ...(config.headers ? { headers: config.headers } : {}) }
			: {
					type: "local",
					command: [config.command ?? "", ...(config.args ?? [])],
					enabled: true,
					...(config.env && Object.keys(config.env).length > 0 ? { environment: config.env } : {}),
				};
	},
	isEnabled: (raw) => (raw as Json)?.enabled !== false,
	withEnabled: (raw, enabled) => ({ ...(raw as Json), enabled }),
};

export function createOpencodeMcpStore(options: { log?: (text: string) => void } = {}): McpStore {
	return createJsonMcpStore({
		engine: "opencode",
		label: "opencode",
		globalPath: () => opencodeConfigPath(),
		projectPath: (workspace) => opencodeConfigPath(workspace),
		shape: opencodeShape,
		can: { add: true, remove: true, toggle: true },
		...(options.log ? { log: options.log } : {}),
	});
}
