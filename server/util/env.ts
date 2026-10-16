/**
 * 配置与环境变量（ADR-0007 §环境变量、ADR-0011 命名）。
 *
 * 四个环境变量，仅此四个：
 *   AGENT_WEB_PORT       默认 8790
 *   AGENT_WEB_CWD        默认 process.cwd()
 *   AGENT_WEB_DATA_DIR   默认 ~/.agent-web
 *   AGENT_WEB_TOKEN      占位：v1 不实现鉴权（ADR-0006），只留开关位
 * 外加一个日志级别：AGENT_WEB_LOG（debug|info|warn|error，默认 info）
 *
 * 刻意**不提供** HOST 变量：监听地址永远绑 127.0.0.1（ADR-0006），
 * 安全决策不应该能被一个环境变量绕过。
 *
 * 本模块全是纯函数：不读 process.env、不碰文件系统 —— 便于单测与守卫复用。
 */
import { join, resolve, sep } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 引擎选择（ADR-0016）：默认用真实 pi SDK；`fake` 只给测试与离线演示用。 */
export type EngineName = "pi" | "fake";

export type Config = {
	port: number;
	readonly host: "127.0.0.1";
	workspace: string;
	dataDir: string;
	logLevel: LogLevel;
	engine: EngineName;
	/** ADR-0006：v1 不实现，仅保留开关位 */
	token: string | null;
};

export const DEFAULT_PORT = 8790;
export const DEFAULT_DATA_DIR_NAME = ".agent-web";
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

	let engine: EngineName = "pi";
	const rawEngine = env.AGENT_WEB_ENGINE;
	if (rawEngine !== undefined && rawEngine !== "") {
		const normalized = rawEngine.toLowerCase();
		if (normalized === "pi" || normalized === "fake") engine = normalized;
		else problems.push(`AGENT_WEB_ENGINE 不是合法值：${rawEngine}（可选 pi / fake，回落到 pi）`);
	}

	return {
		config: {
			port,
			host: "127.0.0.1",
			workspace: env.AGENT_WEB_CWD && env.AGENT_WEB_CWD !== "" ? resolve(env.AGENT_WEB_CWD) : resolve(options.cwd),
			dataDir:
				env[DATA_DIR_ENV] && env[DATA_DIR_ENV] !== ""
					? resolve(env[DATA_DIR_ENV] as string)
					: join(options.home, DEFAULT_DATA_DIR_NAME),
			logLevel,
			engine,
			token: env.AGENT_WEB_TOKEN && env.AGENT_WEB_TOKEN !== "" ? env.AGENT_WEB_TOKEN : null,
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
	if (config.host !== "127.0.0.1") {
		problems.push(`监听地址必须是 127.0.0.1：${config.host}（ADR-0006）`);
	}
	return problems;
}
