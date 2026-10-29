/**
 * MCP 面板的数据形状（服务端 `/api/mcp` 回的那一份）与几个纯函数。
 *
 * 单独放一个文件是为了守住「单文件 400 行」（ADR-0010）：面板与详情两个组件
 * 都要认这套类型，放谁那儿都会让另一个变成「从兄弟组件里 import 类型」的乱账。
 */

export type Scope = "global" | "project";
export type Exposure = "codemode" | "deferred" | "direct" | "hidden";

type EnvRef = { key: string; variable: string; present: boolean };
type ToolInfo = { name: string; description?: string };

/** 一次「测试连接」的结果 */
export type Probe = {
	ok: boolean;
	at: number;
	ms: number;
	tools: ToolInfo[];
	serverName?: string;
	serverVersion?: string;
	protocolVersion?: string;
	error?: string;
	stderr?: string;
};

export type Server = {
	name: string;
	scope: Scope;
	source: string;
	override?: string;
	enabled: boolean;
	exposure: Exposure;
	description?: string;
	timeout: number;
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	toolExposure?: Record<string, Exposure>;
	envRefs: EnvRef[];
	/** pi 存过这一台的 OAuth 凭据吗 */
	auth?: { present: boolean; expired: boolean; scope?: string };
	probe?: Probe;
	/** 非 pi 引擎的一句话说明（codex 的运行状态 / 插件来源、opencode 的 local/remote…） */
	note?: string;
	/** 引擎已经报上来的工具清单（codex 的 mcpServerStatus/list 直接给） */
	tools?: ToolInfo[];
};

/** 一次 OAuth 登录的状态（`pi mcp login` 子进程） */
export type LoginState = {
	name: string;
	status: "waiting" | "done" | "failed" | "cancelled";
	/** 授权页地址（带 PKCE 与回调端口，必须原样打开） */
	url?: string;
	startedAt: number;
	message?: string;
};

export type View = {
	servers?: Server[];
	/** 这份数据属于哪个引擎（切引擎 = 换口径；pi 不填） */
	engine?: string;
	/** 人话源头：`Codex · ~/.codex/config.toml` */
	source?: string;
	/** 这个引擎允许面板做哪些动作（不支持的按钮不画） */
	can?: { add: boolean; remove: boolean; toggle: boolean; test: boolean; expose: boolean; login: boolean };
	globalPath?: string;
	projectPath?: string;
	projectExists?: boolean;
	errors?: string[];
	autoEnableCodemode?: boolean;
	enabled?: number;
	total?: number;
	actionError?: string;
	notice?: string;
	error?: string | { message?: string };
};

export type Action =
	| "add"
	| "parse"
	| "remove"
	| "set-enabled"
	| "set-scope-enabled"
	| "set-exposure"
	| "test"
	| "login"
	| "login-status"
	| "login-cancel";

export const EXPOSURE_LABEL: Record<Exposure, string> = {
	codemode: "代码模式（默认）",
	deferred: "搜索后声明",
	direct: "直接声明",
	hidden: "不暴露",
};

export const EXPOSURE_HINT: Record<Exposure, string> = {
	codemode: "只列出服务器名称和简介，代码模式脚本按需搜索它的工具。",
	deferred: "模型先用 tool_search 搜到、下一轮才声明出来，然后直接调用。",
	direct: "像内置工具一样直接声明给模型，最省事也最占上下文。",
	hidden: "注册但不暴露：工具还在，模型碰不到。",
};

/** 连接失败是不是「没登录」（pi 的客户端把 401 统一报成 requires authentication） */
export function needsLogin(error: string | undefined): boolean {
	if (error === undefined) return false;
	return /requires authentication|unauthori[sz]ed|invalid_token|\b401\b/i.test(error);
}

export const SCOPE_LABEL: Record<Scope, string> = { global: "全局", project: "项目" };

/** 服务器身份：作用域 + 名字（同名可能同时存在于项目和全局） */
export function serverKey(server: { scope: Scope; name: string }): string {
	return `${server.scope}:${server.name}`;
}

/** 服务端两种错误形态：整体错误回 `{code,message}`，操作结果里是字符串 —— 都认 */
export function errorText(view: View, status: number): string {
	if (typeof view.error === "string") return view.error;
	return view.error?.message ?? `HTTP ${status}`;
}

/** stdio 服务器的完整命令行（面板上照配置原样显示，方便对比 mcp.json） */
export function commandLine(server: Server): string {
	return [server.command ?? "", ...(server.args ?? [])].filter((part) => part !== "").join(" ");
}

/** 一个值是不是「整条命令」（`!cmd`）：pi 会跑它，把 stdout 当值用 */
export function isCommandValue(value: string): boolean {
	return value.startsWith("!");
}
