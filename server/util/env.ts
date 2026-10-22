/**
 * 配置与环境变量（ADR-0007 §环境变量、ADR-0011 命名）。
 *
 * 四个环境变量，仅此四个：
 *   AGENT_WEB_PORT       默认 25257
 *   AGENT_WEB_CWD        默认 process.cwd()
 *   AGENT_WEB_DATA_DIR   默认 ~/.oh-my-agent-web
 *   AGENT_WEB_HOST       默认 127.0.0.1（对外监听需要它）
 *   AGENT_WEB_PASSWORD   远程访问密码（不设 = 只允许本机）
 *   AGENT_WEB_ALLOWED_HOSTS  额外允许的域名（逗号分隔，默认只认 loopback）
 *   AGENT_WEB_TOKEN      占位：v1 不实现鉴权（ADR-0006），只留开关位
 * 外加一个日志级别：AGENT_WEB_LOG（debug|info|warn|error，默认 info）
 *
 * 监听地址默认 127.0.0.1；改成别的地址也**不会**让远程随便进 ——
 * 没有 AGENT_WEB_PASSWORD 时，非本机请求一律 403（ADR-0031）。
 *
 * 本模块全是纯函数：不读 process.env、不碰文件系统 —— 便于单测与守卫复用。
 */
import { join, resolve, sep } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 引擎选择（ADR-0016 + ADR-0024）：只是个注册名，默认 `pi`。
 * 具体有哪些在注册表里；未注册的名字由接线层回落并告警（加引擎不用改这里）。
 */
export type EngineName = string;

export type Config = {
	port: number;
	host: string;
	workspace: string;
	dataDir: string;
	logLevel: LogLevel;
	engine: EngineName;
	/** 回合看门狗超时（ADR-0023）：超时自动中断并提示 */
	turnTimeoutMs: number;
	/** ADR-0006：v1 不实现，仅保留开关位 */
	token: string | null;
	/** codex 可执行文件（默认 PATH 里的 codex） */
	codexBin: string;
	/** 单独的 CODEX_HOME（不给就用 ~/.codex） */
	codexHome: string | null;
	/** dsh 可执行文件（默认 PATH 里的 dsh） */
	dshBin: string;
	/** 单独的 DSH_HOME（不给就用 ~/.dsh） */
	dshHome: string | null;
	/** 新会话优先用的 DSH 模型路由（provider/model）；不给就自动挑 */
	dshModel: string | null;
	/** 额外的 dsh patch 文件（`--patch` 叠加层；冒号分隔） */
	dshPatches: string[];
	/** 非本机访问时要求的密码（明文只存在进程内存里）；空 = 只允许本机访问 */
	password: string | null;
	/** 额外允许的主机名（域名 / 局域网 IP）：用自己的域名访问时要配它 */
	allowedHosts: string[];
};

export const DEFAULT_PORT = 25257;
/** 默认只听本机；要对外提供访问得显式改它 + 设密码（ADR-0031） */
export const DEFAULT_HOST = "127.0.0.1";
export const HOST_ENV = "AGENT_WEB_HOST";
export const PASSWORD_ENV = "AGENT_WEB_PASSWORD";
/** 额外允许的主机名（逗号分隔）：用自己的域名 / 局域网 IP 访问时配它 */
export const ALLOWED_HOSTS_ENV = "AGENT_WEB_ALLOWED_HOSTS";
/** 回合看门狗默认超时：20 分钟（与参考实现同口径） */
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_DATA_DIR_NAME = ".oh-my-agent-web";
/**
 * 旧的数据目录名（改名前的）。
 *
 * 里面装的是**这台机器的私有配置**：远程访问密码、允许的域名、审批规则、推送订阅、
 * 客户端设置、日志和锁。改名不能让这些凭空消失，所以启动时会**自动搬家**
 * （见 `server/util/data-dir.ts`），搬完旧目录就不存在了。
 */
export const LEGACY_DATA_DIR_NAME = ".agent-web";
export const DATA_DIR_ENV = "AGENT_WEB_DATA_DIR";

/** ADR-0011：绝不与参考实现（~/.pi-web）共用数据目录 —— 否则两边会互相覆盖会话与配置 */
export const FOREIGN_DATA_DIR_NAMES = [".pi-web", ".pi"];

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export type EnvLike = Record<string, string | undefined>;

export type ReadConfigOptions = {
	home: string;
	cwd: string;
};

export type ConfigResult = {
	config: Config;
	/** 环境变量本身就有问题（非法值等）；启动时应打印并退出（ADR-0007 启动自检） */
	problems: string[];
};

export function readConfig(env: EnvLike, options: ReadConfigOptions): ConfigResult {
	const problems: string[] = [];

	let port = DEFAULT_PORT;
	const rawPort = env.AGENT_WEB_PORT;
	if (rawPort !== undefined && rawPort !== "") {
		const parsed = Number.parseInt(rawPort, 10);
		if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;
		else problems.push(`AGENT_WEB_PORT 不是合法端口：${rawPort}（回落到 ${DEFAULT_PORT}）`);
	}

	let logLevel: LogLevel = "info";
	const rawLevel = env.AGENT_WEB_LOG;
	if (rawLevel !== undefined && rawLevel !== "") {
		if (LOG_LEVELS.includes(rawLevel as LogLevel)) logLevel = rawLevel as LogLevel;
		else problems.push(`AGENT_WEB_LOG 不是合法级别：${rawLevel}（回落到 info）`);
	}

	let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
	const rawTimeout = env.AGENT_WEB_TURN_TIMEOUT_MS;
	if (rawTimeout !== undefined && rawTimeout !== "") {
		const parsedTimeout = Number.parseInt(rawTimeout, 10);
		if (Number.isInteger(parsedTimeout) && parsedTimeout >= 0) turnTimeoutMs = parsedTimeout;
		else problems.push(`AGENT_WEB_TURN_TIMEOUT_MS 不是合法毫秒数：${rawTimeout}（回落到默认）`);
	}

	let engine: EngineName = "pi";
	const rawEngine = env.AGENT_WEB_ENGINE;
	if (rawEngine !== undefined && rawEngine !== "") {
		// 只做形状归一化；**是不是注册过的引擎**由注册表判断（ADR-0024）：
		// 未注册的名字在那里回落 pi 并告警 —— 这样加引擎不用改这里
		engine = rawEngine.trim().toLowerCase();
	}

	let host = DEFAULT_HOST;
	const rawHost = env[`${HOST_ENV}`];
	if (rawHost !== undefined && rawHost !== "") host = rawHost.trim();
	const password = env[`${PASSWORD_ENV}`] && env[`${PASSWORD_ENV}`] !== "" ? String(env[`${PASSWORD_ENV}`]) : null;
	const allowedHosts = (env[ALLOWED_HOSTS_ENV] ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return {
		config: {
			port,
			host,
			workspace: env.AGENT_WEB_CWD && env.AGENT_WEB_CWD !== "" ? resolve(env.AGENT_WEB_CWD) : resolve(options.cwd),
			dataDir:
				env[DATA_DIR_ENV] && env[DATA_DIR_ENV] !== ""
					? resolve(env[DATA_DIR_ENV] as string)
					: join(options.home, DEFAULT_DATA_DIR_NAME),
			logLevel,
			engine,
			turnTimeoutMs,
			token: env.AGENT_WEB_TOKEN && env.AGENT_WEB_TOKEN !== "" ? env.AGENT_WEB_TOKEN : null,
			codexBin: env.AGENT_WEB_CODEX_BIN?.trim() || "codex",
			codexHome: env.AGENT_WEB_CODEX_HOME?.trim() || null,
			dshBin: env.AGENT_WEB_DSH_BIN?.trim() || "dsh",
			dshHome: env.AGENT_WEB_DSH_HOME?.trim() || null,
			dshModel: env.AGENT_WEB_DSH_MODEL?.trim() || null,
			dshPatches: (env.AGENT_WEB_DSH_PATCH ?? "")
				.split(":")
				.map((item) => item.trim())
				.filter((item) => item !== ""),
			password,
			allowedHosts,
		},
		problems,
	};
}

/** 去掉尾部分隔符（保留根目录 `/`），便于比较 */
export function normalizeDir(path: string): string {
	const resolved = resolve(path);
	if (resolved === sep) return sep;
	return resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/** ADR-0006：工作区根不得是家目录，也不得是文件系统根 */
export function isForbiddenWorkspaceRoot(workspace: string, home: string): boolean {
	const normalized = normalizeDir(workspace);
	return normalized === normalizeDir(home) || normalized === normalizeDir(sep);
}

/** ADR-0011：数据目录不得是参考实现的目录 */
export function isForeignDataDir(dataDir: string): boolean {
	const base = normalizeDir(dataDir).split(sep).pop() ?? "";
	return FOREIGN_DATA_DIR_NAMES.includes(base);
}

/** 结构性校验：与 env 值是否合法无关，属「这个配置能不能安全地跑起来」 */
export function validateConfig(config: Config, options: { home: string }): string[] {
	const problems: string[] = [];
	if (isForbiddenWorkspaceRoot(config.workspace, options.home)) {
		problems.push(`工作区根不能是家目录或文件系统根：${config.workspace}（ADR-0006）`);
	}
	if (isForeignDataDir(config.dataDir)) {
		problems.push(`数据目录不能与参考实现共用：${config.dataDir}（ADR-0011，会互相覆盖会话）`);
	}
	return problems;
}
