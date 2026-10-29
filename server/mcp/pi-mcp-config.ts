/**
 * MCP 服务器配置（`mcp.json`）的读写。
 *
 * 「谁说了算：pi 自己」—— 这里不另立一套语义，而是照抄 pi 1.3 的
 * `pi-coding-agent/dist/extensions/mcp/config.js`（`loadMcpConfig` / `addMcpServerConfig` /
 * `updateMcpServerConfig` / `removeMcpServerConfig`）。照抄而不是 import 的原因：那个文件
 * 只在包的 `exports` 里露了 `"."`，`dist/extensions/mcp/config.js` 是深路径，Node 会直接拒。
 *
 * 要保持一致的四条：
 *   - **两个作用域**：全局 `~/.pi/agent/mcp.json` + 项目 `<workspace>/.pi/mcp.json`；
 *     会话启动时读的就是这两份，所以面板显示的就是这个项目里真正会连的东西。
 *   - **项目覆盖全局**：同名条目在项目里出现就顶掉全局的；项目里只写
 *     `enabled` / `exposure` / `toolExposure` 的（没有 command/url/type）是「覆盖项」，
 *     其余字段沿用全局那份 —— 一个项目想临时关掉一个全局服务器就这么写。
 *   - **名字约束**：只允许字母数字下划线连字符；只差 `-` / `_` 的两个名字会撞进同一个
 *     工具命名空间（`mcp__<name>`），算冲突。
 *   - **写回保留现场**：只改 `mcpServers` 里目标那一项，其它内容与缩进原样不动。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type McpScope = "global" | "project";

/** 工具怎么交给模型：脚本里调 / 搜索后再声明 / 直接声明 / 不暴露 */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

export const MCP_EXPOSURES: McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
export const DEFAULT_EXPOSURE: McpExposure = "codemode";

/**
 * 一份服务器配置。字段与 pi 的 `McpServerConfig` 同构；这里刻意写得松（几乎都是可选），
 * 面板要能显示「写得不对」的条目并说明错在哪，而不是读不出来就整块消失。
 */
export type McpServerConfig = {
	type?: "stdio" | "http" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: Record<string, unknown>;
	auth?: { provider?: string };
	enabled?: boolean;
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
	timeout?: number;
	description?: string;
};

export type McpServerEntry = {
	name: string;
	config: McpServerConfig;
	/** 定义它的文件（全局或项目的 mcp.json） */
	source: string;
	scope: McpScope;
	/** 项目文件里「覆盖全局那条」的路径；有它就说明这条最终配置来自两份文件 */
	override?: string;
};

type LoadedMcpConfig = {
	servers: McpServerEntry[];
	errors: string[];
	autoEnableCodemode?: boolean;
	projectConfig?: string;
};

type McpConfigPatch = { enabled?: boolean; exposure?: McpExposure };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];
const CONFIG_DIR_NAME = ".pi";
/** 与 pi 一致的「本地回环白名单」，用于 https 的例外判断 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

export function globalMcpPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

export function projectMcpPath(workspace: string): string {
	return join(workspace, CONFIG_DIR_NAME, "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isExposure(value: unknown): value is McpExposure {
	return MCP_EXPOSURES.includes(value as McpExposure);
}

/** `codemode-deferred` 是 `codemode` 的别名（pi 认，这里也认，读到就归一化） */
function normalizeExposure(value: unknown): unknown {
	return value === "codemode-deferred" ? "codemode" : value;
}

/** 工具的命名空间：`mcp__<name>`，非字母数字下划线一律换成下划线 */
function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** 是不是「只覆盖几个键」的条目（没有 command / url / type 就算） */
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

/**
 * 校验一条 `mcpServers` 条目，返回归一化后的配置或错误文案。
 * 只覆盖面板能写出来的部分（command / url / 通用键）；`oauth` / `auth` 原样带过 ——
 * 那两个只有 `pi mcp` 与手写配置文件才设得上，面板不碰也就没资格判它错。
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `服务器名 "${name}" 不合法（只能用字母、数字、"_" 和 "-"）`;
	if (!isRecord(raw)) return `服务器 "${name}" 必须是一个对象`;
	const value: Record<string, unknown> = { ...raw };
	if (value.exposure !== undefined) value.exposure = normalizeExposure(value.exposure);

	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	if (exposure !== undefined && !isExposure(exposure)) {
		return `服务器 "${name}"：exposure 只能是 ${MCP_EXPOSURES.map((item) => `"${item}"`).join("、")}`;
	}
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `服务器 "${name}"：toolExposure 必须是「工具名 → exposure」的对象`;
		for (const [tool, item] of Object.entries(toolExposure)) {
			if (!isExposure(item)) return `服务器 "${name}"：toolExposure 里 "${tool}" 的 exposure 不合法`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `服务器 "${name}"：enabled 必须是布尔值`;
	if (description !== undefined && typeof description !== "string") return `服务器 "${name}"：description 必须是字符串`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `服务器 "${name}"：timeout 必须是正数（秒）`;
	}
	if (type === "sse") return `服务器 "${name}"：pi 不支持老的 SSE 传输，请填 streamable HTTP 的地址`;

	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			return `服务器 "${name}"：url 必须是 http / https 地址`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `服务器 "${name}"：headers 必须是「名字 → 字符串」的对象`;
		}
		if (value.auth !== undefined) {
			const provider = isRecord(value.auth) ? value.auth.provider : undefined;
			if (typeof provider !== "string" || provider === "") {
				return `服务器 "${name}"：auth.provider 必须是 provider 名`;
			}
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				return `服务器 "${name}"：用 auth 时必须 https，或 http 且主机是 localhost / 127.0.0.1 / [::1]`;
			}
		}
		return value as McpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `服务器 "${name}"：args 必须是字符串数组`;
		}
		if (value.env !== undefined && !isStringRecord(value.env))
			return `服务器 "${name}"：env 必须是「名字 → 字符串」的对象`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `服务器 "${name}"：cwd 必须是字符串`;
		return value as McpServerConfig;
	}
	return `服务器 "${name}" 需要 "command"（stdio）或 "url"（streamable HTTP）`;
}

/** 读一份 mcp.json；文件不存在就当空配置（不报错，第一次装服务器时才会创建） */
function readConfigFile(
	path: string,
	scope: McpScope,
	state: { servers: Map<string, McpServerEntry>; errors: string[] },
): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		state.errors.push(`${path}：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		state.errors.push(`${path}：顶层应该是对象，且 mcpServers 也是一个对象`);
		return;
	}
	if (parsed.autoEnableCodemode !== undefined && typeof parsed.autoEnableCodemode !== "boolean") {
		state.errors.push(`${path}：autoEnableCodemode 必须是布尔值`);
	}

	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			const base = state.servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) {
				state.errors.push(`${path}：服务器 "${name}" 需要 "command" 或 "url"，或者得有一个同名的全局服务器可覆盖`);
				continue;
			}
			if (extra.length > 0) {
				state.errors.push(`${path}：服务器 "${name}" 作为项目覆盖项时只能设 ${OVERRIDE_KEYS.join(" / ")}`);
				continue;
			}
			const merged: Record<string, unknown> = { ...base.config, ...value };
			if (merged.exposure !== undefined) merged.exposure = normalizeExposure(merged.exposure);
			state.servers.set(name, { ...base, config: merged as McpServerConfig, override: path });
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			state.errors.push(`${path}：${config}`);
			continue;
		}
		// 只差 `-` / `_` 的两个名字会落进同一个工具命名空间
		const clash = [...state.servers.keys()].find(
			(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
		);
		if (clash) {
			state.errors.push(`${path}：服务器 "${name}" 与 "${clash}" 撞了同一个工具命名空间`);
			continue;
		}
		if (scope === "project" && config.url !== undefined && config.auth !== undefined) {
			state.errors.push(`${path}：服务器 "${name}" 的 auth 只能写在全局 mcp.json 里`);
			continue;
		}
		state.servers.set(name, { name, config, source: path, scope });
	}
}

/**
 * 读全局 + 项目两份配置并合并。停用的服务器也带上（`enabled: false`），
 * 这样面板能把它们显示出来、再点一下开回来。
 */
export function loadMcpConfig(options: { agentDir: string; workspace: string }): LoadedMcpConfig {
	const state = { servers: new Map<string, McpServerEntry>(), errors: [] as string[] };
	const autoEnable = { value: undefined as boolean | undefined };
	readConfigFile(globalMcpPath(options.agentDir), "global", state);
	const projectConfig = projectMcpPath(options.workspace);
	// 顺手把 autoEnableCodemode 读出来（面板要显示「代码模式会不会自动打开」）
	for (const path of [globalMcpPath(options.agentDir), projectConfig]) {
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed) && typeof parsed.autoEnableCodemode === "boolean")
				autoEnable.value = parsed.autoEnableCodemode;
		} catch {
			/* 上面 readConfigFile 已经报过错了 */
		}
	}
	readConfigFile(projectConfig, "project", state);
	return {
		servers: [...state.servers.values()],
		errors: state.errors,
		...(autoEnable.value === undefined ? {} : { autoEnableCodemode: autoEnable.value }),
		projectConfig,
	};
}

/**
 * 读一份 mcp.json → 让 `edit` 改它的 `mcpServers` → 有改动就按原缩进写回。
 * 缩进从原文里猜（正则取第一行缩进行），跟 pi 的做法一致，免得一次保存把整个文件重排。
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}：顶层应该是对象，且 mcpServers 也是一个对象`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	// 文件原本是 CRLF 就写回 CRLF：只改一个开关却把整个文件改成 LF，
	// 在 git 里就是「全文件都变了」（Windows 用户默认就是 CRLF）
	const eol = text !== undefined && text.includes("\r\n") ? "\r\n" : "\n";
	mkdirSync(dirname(path), { recursive: true });
	writeTextAtomic(path, `${JSON.stringify(parsed, null, indent)}${eol}`);
}

/**
 * 原子写文本：先写同目录临时文件，再 `rename` 覆盖。
 *
 * 为什么不直接 `writeFileSync(path, …)`：它是「先截断后写」。Windows 上文件正被
 * 编辑器 / 杀软 / 另一个 pi 进程打开时会在中途 `EBUSY`/`EPERM`，结果留下**半截 JSON** ——
 * 下次启动直接报文件损坏，用户刚改的配置全丢。`rename` 在 Windows 上走 MoveFileEx，
 * 要么整个换过去要么原文件不动，不会有中间态。
 */
function writeTextAtomic(path: string, content: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	try {
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// 临时文件都没了就没有可清的
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${path} 写入失败（文件可能正被其它程序占用）：${reason}`);
	}
}

/**
 * 改一个服务器的启停 / 暴露方式。
 *
 * `override: true` 时目标文件是「项目覆盖项」：条目不存在就新建一个空的（覆盖项只带默认值以外的键），
 * 与 pi 的 `/mcp` 行为一致。`enabled: true` / `exposure: "codemode"` 是默认值，写回去时删掉键，
 * 免得配置文件越写越长。
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} 里没有 MCP 服务器 "${name}"`);
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === DEFAULT_EXPOSURE && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}

/** 往 mcp.json 里加一条（同名就替换）；返回是不是替换了已有条目 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** 从 mcp.json 里删一条；返回是不是真删了 */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}
