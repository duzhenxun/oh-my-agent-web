/**
 * 日志（ADR-0013）：单行 JSON、带 scope 与 level。
 *
 * M1 只落到 stdout（前台运行＝直接看得见）；
 * 文件输出与按大小轮转是 M3 的事（ADR-0013 §B），届时只换 sink，不动调用点。
 *
 * 刻意不引日志库（ADR-0008 依赖预算）：这里总共不到 40 行。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, unknown>;

export type LogEntry = {
	ts: number;
	level: LogLevel;
	scope: string;
	msg: string;
	ctx?: LogContext;
};

export type Logger = {
	debug(message: string, ctx?: LogContext): void;
	info(message: string, ctx?: LogContext): void;
	warn(message: string, ctx?: LogContext): void;
	error(message: string, ctx?: LogContext): void;
	child(scope: string): Logger;
};

export type LoggerOptions = {
	level: LogLevel;
	scope?: string;
	now?: () => number;
	sink?: (line: string) => void;
};

/** 纯函数：把一条日志格式化成单行 JSON（便于单测脱敏与字段形状） */
export function formatLogLine(entry: LogEntry): string {
	return JSON.stringify(entry.ctx ? entry : { ...entry, ctx: undefined });
}

export function createLogger(options: LoggerOptions): Logger {
	const now = options.now ?? (() => Date.now());
	const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
	const scope = options.scope ?? "app";
	const threshold = LEVEL_ORDER[options.level];

	const write = (level: LogLevel, message: string, ctx?: LogContext) => {
		if (LEVEL_ORDER[level] < threshold) return;
		sink(formatLogLine({ ts: now(), level, scope, msg: message, ...(ctx ? { ctx } : {}) }));
	};

	return {
		debug: (message, ctx) => write("debug", message, ctx),
		info: (message, ctx) => write("info", message, ctx),
		warn: (message, ctx) => write("warn", message, ctx),
		error: (message, ctx) => write("error", message, ctx),
		child: (childScope) => createLogger({ ...options, scope: `${scope}.${childScope}` }),
	};
}
