/**
 * MCP 的 OAuth 凭据（`~/.pi/agent/mcp-auth.json`）与「登录」这两件事。
 *
 * 为什么要碰这个文件：pi 的 HTTP MCP 服务器要 OAuth 时，凭据由 **pi 自己**存进
 * `mcp-auth.json`（`pi mcp login <server>` 或交互里的 `/mcp` → Sign in 写的）。
 * 面板的「测试连接」如果不带上这个 token，就会对着一个已经登录好的服务器报
 * `MCP server requires authentication` —— 那是**面板的视角错**，不是配置错。
 *
 * 两个入口：
 *   - `readAccessToken`：只读，给测试连接拼 `Authorization: Bearer …`；
 *   - `createMcpLogin`：起一个 `pi mcp login <server>` 子进程（用它自己的 OAuth 流程与
 *     回调端口），把打印出来的授权地址交给界面显示。**不自己实现 OAuth** ——
 *     客户端注册、PKCE、刷新令牌那套跟 pi 运行时必须是同一份实现，否则「面板说登录了、
 *     会话还是 401」这种坑迟早踩到。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "../util/spawn-cli.js";

/** access token 提前多久算过期（pi 用的是 60s，这里保持一致） */
const EXPIRY_SKEW_MS = 60_000;
/** 等子进程打印授权地址的上限 */
const URL_WAIT_MS = 15_000;
/** 授权页最长等多久（`pi mcp login` 自己也有 --timeout，别让它无限挂着） */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export type McpAuthState = {
	/** 有没有存过这一台的凭据 */
	present: boolean;
	/** 存了但已过期（pi 会在真正调用时用 refresh token 续期，所以不算失败） */
	expired: boolean;
	/** 有 scope 就带上，界面上能看出授权范围 */
	scope?: string;
};

type StoredState = {
	tokens?: { access_token?: string; refresh_token?: string; scope?: string };
	tokensExpireAt?: number;
};

function keyOf(name: string, url: string): { key: string; legacyKey: string } {
	const legacyKey = String(new URL(url));
	return { key: `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}|${legacyKey}`, legacyKey };
}

function readStates(agentDir: string): Record<string, StoredState> {
	const path = join(agentDir, "mcp-auth.json");
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, StoredState>) : {};
	} catch {
		return {};
	}
}

function stateOf(agentDir: string, name: string, url: string): StoredState | undefined {
	const states = readStates(agentDir);
	const { key, legacyKey } = keyOf(name, url);
	return states[key] ?? states[legacyKey];
}

/** 这一台在 pi 那里存了凭据吗（只读，不改文件） */
export function readAuthState(agentDir: string, name: string, url: string): McpAuthState {
	const state = stateOf(agentDir, name, url);
	const token = state?.tokens?.access_token;
	if (token === undefined || token === "") return { present: false, expired: false };
	const expiresAt = state?.tokensExpireAt;
	return {
		present: true,
		expired: expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= Date.now(),
		...(state?.tokens?.scope === undefined ? {} : { scope: state.tokens.scope }),
	};
}

/** 测试连接要用的 token：没有、或已过期（且没有 refresh token 可续）就不给 */
export function readAccessToken(agentDir: string, name: string, url: string): string | undefined {
	const state = stateOf(agentDir, name, url);
	const token = state?.tokens?.access_token;
	if (token === undefined || token === "") return undefined;
	const expiresAt = state?.tokensExpireAt;
	if (expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= Date.now() && !state?.tokens?.refresh_token)
		return undefined;
	return token;
}

// ---------------------------------------------------------------------------
// 登录子进程
// ---------------------------------------------------------------------------

export type McpLoginState = {
	name: string;
	status: "waiting" | "done" | "failed" | "cancelled";
	/** 授权页地址（pi 打印出来的那个，带 PKCE 与回调端口） */
	url?: string;
	startedAt: number;
	/** 失败/完成时的一句话 */
	message?: string;
};

export type McpLogin = {
	/** 起一次登录，最多等 15 秒拿到授权地址就返回（之后靠 `status` 轮询） */
	start: (name: string) => Promise<McpLoginState>;
	status: (name: string) => McpLoginState | null;
	cancel: (name: string) => void;
	dispose: () => void;
};

/** pi 自带的 CLI 入口：从 SDK 的模块路径推过去（不依赖全局装没装 `pi`） */
function cliPath(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const candidate = join(dirname(entry), "bundle", "cli.js");
		return existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

export function createMcpLogin(options: { agentDir: string }): McpLogin {
	const sessions = new Map<string, { state: McpLoginState; child?: ChildProcess }>();

	function finish(name: string, patch: Partial<McpLoginState>): void {
		const session = sessions.get(name);
		if (!session) return;
		session.state = { ...session.state, ...patch };
	}

	function start(name: string): Promise<McpLoginState> {
		const existing = sessions.get(name);
		if (existing?.state.status === "waiting" && existing.child !== undefined) return Promise.resolve(existing.state);

		const state: McpLoginState = { name, status: "waiting", startedAt: Date.now() };
		const session: { state: McpLoginState; child?: ChildProcess } = { state };
		sessions.set(name, session);

		const cli = cliPath();
		if (cli === null) {
			finish(name, {
				status: "failed",
				message: "找不到 pi 的命令行入口（@earendil-works/pi-coding-agent 里没有 bundle/cli.js）",
			});
			return Promise.resolve(sessions.get(name)!.state);
		}

		const child = spawn(process.execPath, [cli, "mcp", "login", name, "--timeout", "600"], {
			// 与 oh-my-agent-web 自己找 agent 目录用的是同一个（pi 那边认 PI_CODING_AGENT_DIR）
			env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, PI_AGENT_DIR: options.agentDir },
			stdio: ["ignore", "pipe", "pipe"],
			// Windows 上不加这个会弹一个黑框，并且一直挂到登录流程结束
			windowsHide: true,
		});
		session.child = child;

		return new Promise<McpLoginState>((resolve) => {
			let settled = false;
			let buffer = "";
			const done = (next: McpLoginState) => {
				if (settled) return;
				settled = true;
				clearTimeout(urlTimer);
				clearTimeout(killTimer);
				resolve(next);
			};
			const urlTimer = setTimeout(() => {
				// 15 秒还没打印地址：把当前状态给界面（多半是网络慢），继续等它
				done(sessions.get(name)!.state);
			}, URL_WAIT_MS);
			const killTimer = setTimeout(() => {
				killTree(child);
				finish(name, { status: "failed", message: "等授权超时（10 分钟）" });
			}, LOGIN_TIMEOUT_MS);

			const scan = (chunk: string) => {
				buffer += chunk;
				const match = /(https?:\/\/\S+)/.exec(buffer);
				if (match && sessions.get(name)!.state.url === undefined) {
					finish(name, { url: match[1] });
					done(sessions.get(name)!.state);
				}
			};
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", scan);
			child.stderr?.on("data", scan);

			child.on("error", (error) => {
				finish(name, { status: "failed", message: error.message });
				done(sessions.get(name)!.state);
			});
			child.on("exit", (code) => {
				clearTimeout(urlTimer);
				clearTimeout(killTimer);
				const current = sessions.get(name)?.state;
				// 退出码 0 = 登录成功（pi 写完 mcp-auth.json 就退）；>0 = 失败或被取消
				if (current?.status === "waiting") {
					finish(
						name,
						code === 0
							? { status: "done", message: "已登录" }
							: { status: "failed", message: tailOf(buffer) || `登录失败（退出码 ${code}）` },
					);
				}
				done(sessions.get(name)!.state);
			});
		});
	}

	function status(name: string): McpLoginState | null {
		return sessions.get(name)?.state ?? null;
	}

	function cancel(name: string): void {
		const session = sessions.get(name);
		if (!session) return;
		// 要收整棵树：`pi mcp login` 可能已经拉起了浏览器 opener
		if (session.child) killTree(session.child);
		session.state = { ...session.state, status: "cancelled", message: "已取消" };
	}

	function dispose(): void {
		for (const session of sessions.values()) if (session.child) killTree(session.child);
		sessions.clear();
	}

	return { start, status, cancel, dispose };
}

/** 把子进程输出里最后一行有用的话留下来（失败时告诉用户为什么） */
function tailOf(output: string): string {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("http"));
	return lines.slice(-2).join(" / ").slice(0, 300);
}
