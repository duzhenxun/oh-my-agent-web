/**
 * 「添加 MCP」的粘贴解析：把用户粘进来的一段话变成 `mcp.json` 条目。
 *
 * 一个添加框要收下「所有可能的粘贴物」（各家的安装链接、密码字段、变量引用、i18n 提示）。
 * 这里只取实际会粘的那几种，语义要跟 pi 的配置一致：
 *
 *   1. **URL**：`https://example.com/mcp`（也认 `localhost:3000/mcp` 这种漏了协议头的）
 *   2. **命令行**：`npx -y @modelcontextprotocol/server-filesystem .`
 *   3. **各家 CLI**：`pi mcp add …` / `claude mcp add …` / `codex mcp add …` / `gemini mcp add …`
 *   4. **JSON**：`{ "mcpServers": { … } }`、VS Code 的 `{ "servers": { … } }`、
 *      以及从别人配置里抠出来的一段 `"github": { … }` 片段
 *
 * 三条纪律（都在代码里落到具体位置）：
 *   - **不猜**：认不出来就报错说明为什么，不硬塞成一条坏配置（坏配置在面板里显示成
 *     「连不上」，用户根本看不出是自己粘错了）；
 *   - **只搬 pi 认识的键**：其它客户端的字段（`gallery`、`enabledTools`、`inputs`…）
 *     直接丢掉并在 notes 里说一句，不原样写进 mcp.json；`type: "sse"` 明确拒绝
 *     （pi 不支持 SSE，得换成 streamable HTTP 地址）；
 *   - **重名不覆盖**：名字按「去掉非法字符 → 与已有名字去重」处理，并在 notes 里讲清楚
 *     改成了什么（静默改名一样坑人）。
 *
 * 这里**不做**安全转义那一套（把其它客户端里的 `$`、`!cmd` 转义掉，免得
 * 粘过来的值被 pi 当变量展开）。原因：oh-my-agent-web 的添加框是**给人自己粘自己的配置**用的，
 * 而面板上会把 `${VAR}` 引用和 `!cmd` 都显式画出来（McpDetail），看得见就不会误解。
 */
import { deriveServerName, sanitizeServerName, splitCommandLine, uniqueName } from "./mcp-command.js";
import type { McpServerConfig } from "./pi-mcp-config.js";

export type ParsedMcpServer = {
	name: string;
	config: McpServerConfig;
};

type McpParseResult = {
	servers: ParsedMcpServer[];
	/** 给人看的提示（改名 / 丢掉哪些字段 / 需要自己补的东西），错误排最前 */
	notes: string[];
	error?: string;
};

/** pi 的 `McpServerConfig` 里认的键（其它一律不进 mcp.json） */
const KNOWN_KEYS = new Set([
	"type",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
	"oauth",
	"auth",
	"enabled",
	"exposure",
	"toolExposure",
	"timeout",
	"description",
]);

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
/** 漏了协议头的本机地址：`localhost:3000/mcp` */
const LOOPBACK_NO_SCHEME = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]\S*)?$/i;

/** 剥掉复制时带上的东西：代码围栏、包着的反引号、`<url>`、Markdown 链接 */
function normalizePaste(text: string): string {
	let input = text
		.replace(INVISIBLE, "")
		.replace(/\u00A0/g, " ")
		.trim();
	const fenced = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(input);
	if (fenced) input = fenced[1]!.trim();
	else if (/^`[^`\n]+`$/.test(input)) input = input.slice(1, -1).trim();
	const markdownLink = input.startsWith("[") ? /\]\(([^()\s]+)\)\s*$/.exec(input) : null;
	if (markdownLink) input = markdownLink[1]!;
	if (/^<\S+>$/.test(input)) input = input.slice(1, -1);
	return input;
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** 把一条「别人的配置」搬成 pi 的配置：只留认识的键，问题写进 notes */
function toConfig(raw: unknown, label: string, notes: string[]): McpServerConfig | string {
	if (!isRecord(raw)) return `${label}：不是一个对象`;
	const config: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (KNOWN_KEYS.has(key)) config[key] = value;
		else notes.push(`${label}：丢掉了 pi 不认识的字段 "${key}"`);
	}

	// `"command": ["npx","-y","pkg"]`（opencode 那种写法）→ command + args
	if (Array.isArray(config.command)) {
		const [command, ...args] = config.command.filter((item): item is string => typeof item === "string");
		config.command = command;
		if (config.args === undefined && args.length > 0) config.args = args;
	}

	// `"type": "sse"` 明确拒绝：pi 压根不支持老的 SSE 传输
	if (config.type === "sse") return `${label}：pi 不支持老的 SSE 传输，请换成 streamable HTTP 的地址`;

	// `"url"` + `"headers"` 直接可用；命令行必须有 command
	if (typeof config.url === "string") {
		if (!isHttpUrl(config.url)) return `${label}：url 必须是 http / https 地址`;
		if (config.headers !== undefined && !isStringRecord(config.headers))
			return `${label}：headers 必须是「名字 → 字符串」`;
		return config as McpServerConfig;
	}
	if (typeof config.command === "string") {
		if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((a) => typeof a === "string"))) {
			return `${label}：args 必须是字符串数组`;
		}
		if (config.env !== undefined && !isStringRecord(config.env)) return `${label}：env 必须是「名字 → 字符串」`;
		return config as McpServerConfig;
	}
	return `${label}：要有 "command"（stdio）或 "url"（streamable HTTP）`;
}

/** 从 JSON 里读服务器清单：`mcpServers` / `servers` / 直接就是「名字 → 配置」的片段 */
function readJsonPaste(input: string, taken: string[], notes: string[]): McpParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		// 从别人的配置里抠出来的一段：`"github": { … },`
		try {
			parsed = JSON.parse(`{${input.replace(/,\s*$/, "")}}`);
			notes.push("看起来是从配置里抠出来的一段，已按「名字 → 配置」理解");
		} catch {
			return { servers: [], notes, error: "JSON 解析失败：检查括号、引号和尾逗号" };
		}
	}
	if (!isRecord(parsed)) return { servers: [], notes, error: "JSON 顶层要是一个对象" };

	const container = isRecord(parsed.mcpServers)
		? parsed.mcpServers
		: isRecord(parsed.servers)
			? parsed.servers
			: Object.values(parsed).some((value) => isRecord(value) && ("command" in value || "url" in value))
				? parsed
				: null;
	if (container === null) {
		return { servers: [], notes, error: '没找到 mcpServers：需要 { "mcpServers": { "名字": { "command" | "url" } } }' };
	}

	const servers: ParsedMcpServer[] = [];
	const names = [...taken];
	for (const [rawName, value] of Object.entries(container)) {
		const name = sanitizeServerName(rawName);
		if (name !== rawName) notes.push(`名字 "${rawName}" 只允许字母数字下划线连字符，改成了 "${name}"`);
		const config = toConfig(value, `"${name}"`, notes);
		if (typeof config === "string") {
			notes.push(config);
			continue;
		}
		const finalName = uniqueName(name, names);
		if (finalName !== name) notes.push(`"${name}" 在这个作用域里已经有了，这条存成 "${finalName}"`);
		names.push(finalName);
		servers.push({ name: finalName, config });
	}
	if (servers.length === 0) return { servers, notes, error: "配置里没有一条能用的服务器" };
	return { servers, notes };
}

type CliParse = {
	name?: string;
	url?: string;
	command?: string[];
	env: Record<string, string>;
	headers: Record<string, string>;
};

/**
 * 读 `pi mcp add` / `claude mcp add` / `codex mcp add` / `gemini mcp add`。
 * 四家的旗标大同小异，这里按「认得的旗标吸收、其余当位置参数」处理：
 *   - `--url <u>`：HTTP 服务器（pi）；
 *   - `--env K=V` / `-e K=V`：环境变量；
 *   - `--header K: V` / `--header K=V` / `-H K: V`：请求头；
 *   - `--transport http`：说明后面那个位置参数是 URL；
 *   - `--` 之后全是命令。
 */
function readCliPaste(tokens: string[]): CliParse {
	const out: CliParse = { env: {}, headers: {} };
	const rest: string[] = [];
	let transport: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		const next = () => tokens[index + 1] ?? "";
		if (token === "--") {
			rest.push(...tokens.slice(index + 1));
			break;
		}
		if (token === "--url" || token === "-u") {
			out.url = next();
			index += 1;
			continue;
		}
		if (token === "--env" || token === "-e") {
			const pair = next();
			const eq = pair.indexOf("=");
			if (eq > 0) out.env[pair.slice(0, eq)] = pair.slice(eq + 1);
			index += 1;
			continue;
		}
		if (token === "--header" || token === "-H") {
			const pair = next();
			const sep = pair.search(/[:=]/);
			if (sep > 0) out.headers[pair.slice(0, sep).trim()] = pair.slice(sep + 1).trim();
			index += 1;
			continue;
		}
		if (token === "--transport" || token === "-t") {
			transport = next().toLowerCase();
			index += 1;
			continue;
		}
		// `--name xxx` 这类带值的旗标：吃掉值，不当位置参数
		if (/^--?[a-z-]+$/i.test(token) && next() !== "" && !next().startsWith("-")) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-")) rest.push(token);
	}

	const [first, ...tail] = rest;
	// 命令里带 `add` 的才叫 CLI 形式；`add` 之后第一个位置参数是名字
	const addIndex = rest.indexOf("add");
	const args = addIndex >= 0 ? rest.slice(addIndex + 1) : rest;
	const [maybeName, ...after] = args;
	if (transport === "http" || transport === "streamable-http" || /^https?:\/\//i.test(after[0] ?? "")) {
		return { ...out, name: maybeName, url: out.url ?? after[0], env: out.env, headers: out.headers };
	}
	if (out.url !== undefined) return { ...out, name: maybeName };
	// `claude mcp add http --url …` 之类：只有一个位置参数且像地址
	if (after.length === 0 && maybeName !== undefined && isHttpUrl(maybeName)) {
		return { ...out, url: maybeName };
	}
	return { ...out, name: maybeName, command: after.length > 0 ? after : first === maybeName ? [] : tail };
}

const CLI_PREFIX = /^(?:pi|claude|codex|gemini|droid|qwen)\s+mcp\s+/i;

/**
 * 主入口：一段粘贴 → 若干条服务器配置。
 * `taken` 是目标 `mcp.json` 里已有的名字，用来避免重名覆盖。
 */
export function parseMcpPaste(text: string, taken: string[] = []): McpParseResult {
	const notes: string[] = [];
	const input = normalizePaste(text);
	if (input === "") return { servers: [], notes, error: "还没填内容" };

	// 1) JSON（也认「从配置里抠出来的一段」：`"github": { … }`，它以引号开头）
	if (input.startsWith("{") || input.startsWith("[") || /^"[^"\n]+"\s*:/.test(input)) {
		return readJsonPaste(input, taken, notes);
	}

	// 2) 裸 URL（含漏了协议头的本机地址）
	if (!/\s/.test(input) && (isHttpUrl(input) || LOOPBACK_NO_SCHEME.test(input))) {
		const url = isHttpUrl(input) ? input : `http://${input}`;
		return {
			servers: [{ name: uniqueName(deriveServerName(url), taken), config: { url } }],
			notes: isHttpUrl(input) ? notes : [...notes, `没有协议头，已按 http 处理：${url}`],
		};
	}

	// 3) 各家 CLI
	const tokens = splitCommandLine(input);
	if (CLI_PREFIX.test(input)) {
		const parsed = readCliPaste(tokens);
		if (parsed.url !== undefined) {
			if (!isHttpUrl(parsed.url)) return { servers: [], notes, error: `url 必须是 http / https 地址：${parsed.url}` };
			const config: McpServerConfig = {
				url: parsed.url,
				...(Object.keys(parsed.headers).length > 0 ? { headers: parsed.headers } : {}),
			};
			const name = sanitizeServerName(parsed.name ?? deriveServerName(parsed.url));
			return { servers: [{ name: uniqueName(name, taken), config }], notes };
		}
		const command = parsed.command ?? [];
		if (command.length === 0) return { servers: [], notes, error: "没读出要启动的命令（命令行后面跟的那一段）" };
		const [exec, ...args] = command;
		const config: McpServerConfig = {
			command: exec!,
			...(args.length > 0 ? { args } : {}),
			...(Object.keys(parsed.env).length > 0 ? { env: parsed.env } : {}),
		};
		const name = sanitizeServerName(parsed.name ?? deriveServerName(command.join(" ")));
		return { servers: [{ name: uniqueName(name, taken), config }], notes };
	}

	// 4) 普通命令行
	const [command, ...args] = tokens;
	if (command === undefined) return { servers: [], notes, error: "没读出命令" };
	const name = uniqueName(deriveServerName(input), taken);
	return {
		servers: [{ name, config: { command, ...(args.length > 0 ? { args } : {}) } }],
		notes,
	};
}
