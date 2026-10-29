/**
 * 「测试连接」：按配置真起一次连接、握手、`tools/list`，然后立刻关掉。
 *
 * 从 `mcp-store.ts` 拆出来（那个负责清单与增删改，这个只管「连一次看看」）：
 * 这里是唯一会**主动起进程 / 打网络**的地方，单独一眼能看全，审起来心里有数。
 *
 * 用的客户端是 pi 自己那份（`@earendil-works/pi-mcp`），所以协议版本、请求头
 * （`Accept: application/json, text/event-stream`）与运行时完全一致 ——
 * 自己手搓一份 JSON-RPC 只会在「面板说通了、会话却连不上」时给人添堵。
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { packageMeta } from "../util/version.js";
import { shellCommand } from "../util/spawn-cli.js";
import type { McpProbeResult } from "./mcp-store.js";
import type { McpServerConfig, McpServerEntry } from "./pi-mcp-config.js";

/** 测试连接的硬上限：配置里的 timeout 再大，面板也不陪它等（30s 已经够任何人耐心） */
const PROBE_CEILING_MS = 30_000;
/** 配置里没写 timeout 时 pi 的默认值（秒） */
export const PROBE_TIMEOUT_SEC = 60;

/** 相对 cwd 按 pi 的规矩解析：`~` 开头是家目录，相对路径挂在会话工作目录上 */
function resolveCwd(raw: string | undefined, workspace: string): string {
	if (!raw) return workspace;
	// 不能用 HOME：Windows 上家目录是 USERPROFILE，homedir() 已经把这层差异包了
	const home = homedir();
	if (raw === "~") return home;
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(home, raw.slice(2));
	return isAbsolute(raw) ? raw : join(workspace, raw);
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** pi 的规矩：`${NAME}` 取环境变量，`!cmd` 跑命令取 stdout；同时报告缺了哪些变量 */
function resolveValue(raw: string): { value: string; missing: string[] } {
	if (raw.startsWith("!")) {
		try {
			// Windows 上 /bin/sh 不存在：让 shellCommand 按平台选 cmd.exe / bin/sh
			const shell = shellCommand(raw.slice(1));
			const out = execFileSync(shell.file, shell.args, {
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			});
			return { value: out.trim(), missing: [] };
		} catch {
			return { value: "", missing: [] };
		}
	}
	const missing: string[] = [];
	const value = raw.replace(ENV_REF, (_match, name: string, fallback?: string) => {
		const got = process.env[name];
		if (got === undefined && fallback === undefined) missing.push(name);
		return got ?? fallback ?? "";
	});
	return { value, missing };
}

/** stderr 常常几十行，面板只放得下一屏：只留尾巴 */
function tail(text: string, max = 1200): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * 不往 MCP 子进程里塞的敏感环境变量名。
 *
 * 以前 stdio 传输是 `inheritEnv: true`：一个从市场装来的第三方 MCP 服务（很可能只是一个
 * `npx -y some-mcp` 命令）能直接读到 `AGENT_WEB_PASSWORD`、各种 `*_API_KEY` / `*_TOKEN` ——
 * 把本机所有凭证都交给一个没有任何审查的包，这是最不该开的一条口子。
 *
 * 真要传密钥就**在 MCP 配置的 env 里显式写** `${env:XXX}`：那是用户自己做的决定。
 */
const SECRET_ENV_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i;

function inheritedEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("AGENT_WEB_")) continue; // 本应用自己的密码 / 数据目录
		if (SECRET_ENV_PATTERN.test(key)) continue; // 各种 *_API_KEY / *_TOKEN
		out[key] = value;
	}
	return out;
}

function stdioTransport(config: McpServerConfig, workspace: string): McpTransport {
	// 先铺一层**过滤过的**继承环境（PATH / HOME / LANG 这些得留），再叠上配置里显式声明的
	const env: Record<string, string> = inheritedEnv();
	for (const [key, value] of Object.entries(config.env ?? {})) env[key] = resolveValue(value).value;
	return new StdioTransport({
		command: resolveValue(config.command ?? "").value,
		args: (config.args ?? []).map((arg) => resolveValue(arg).value),
		cwd: resolveCwd(config.cwd, workspace),
		env,
		// 不再 inheritEnv：整份 process.env（含凭证）不能倒给一个没审查过的子进程
		inheritEnv: false,
		// stderr 收集起来：连不上时那几行才是有用的话（`command not found` 之类）
		stderr: "pipe",
	});
}

function httpTransport(config: McpServerConfig, accessToken?: string): McpTransport {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = resolveValue(value).value;
	// 配置里自己写了 Authorization 就以它为准；否则用 pi 存下来的 OAuth token
	if (accessToken !== undefined && headers.Authorization === undefined && headers.authorization === undefined) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
	return new StreamableHttpTransport({ url: config.url ?? "", headers, openGetStream: false });
}

export async function probeServer(
	entry: McpServerEntry,
	workspace: string,
	timeoutSec: number,
	/** pi 存下来的 OAuth access token（`mcp-auth.json`）：没登录就没有 */
	accessToken?: string,
): Promise<McpProbeResult> {
	const started = Date.now();
	const budget = Math.min(timeoutSec * 1000, PROBE_CEILING_MS);
	let transport: McpTransport | undefined;
	const meta = packageMeta();
	const client = new McpClient({
		name: "oh-my-agent-web",
		version: meta.version,
		requestTimeoutMs: budget,
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void transport?.close();
	}, budget);

	try {
		transport =
			entry.config.url !== undefined
				? httpTransport(entry.config, accessToken)
				: stdioTransport(entry.config, workspace);
		await client.connect(transport);
		const tools = await client.listTools();
		return {
			ok: true,
			at: Date.now(),
			ms: Date.now() - started,
			tools: tools.map((tool) => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
			})),
			...(client.serverInfo?.name === undefined ? {} : { serverName: client.serverInfo.name }),
			...(client.serverInfo?.version === undefined ? {} : { serverVersion: client.serverInfo.version }),
			...(client.protocolVersion === undefined ? {} : { protocolVersion: client.protocolVersion }),
		};
	} catch (error) {
		const stderr = transport instanceof StdioTransport ? tail(transport.stderr) : "";
		return {
			ok: false,
			at: Date.now(),
			ms: Date.now() - started,
			tools: [],
			error: timedOut
				? `连接超时（${Math.round(budget / 1000)}s）`
				: error instanceof Error
					? error.message
					: String(error),
			...(stderr === "" ? {} : { stderr }),
		};
	} finally {
		clearTimeout(timer);
		await transport?.close().catch(() => undefined);
	}
}
