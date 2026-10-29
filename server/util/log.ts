/**
 * 日志（ADR-0013）：单行 JSON、带 scope 与 level。
 *
 * 默认只写 stdout（前台运行＝直接看得见）；文件输出与按大小轮转由 `log-file.ts` 提供 sink（ADR-0013 §B）。
 *
 * 刻意不引日志库（ADR-0008 依赖预算）：这里总共不到 40 行。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type LogContext = Record<string, unknown>;

/** 这些 key 的值一律不写日志（ADR-0013 §脱敏） */
const SECRET_KEY_RE = /(key|token|secret|password|passwd|credential|authorization|cookie)/i;
const MAX_VALUE_CHARS = 200;

function redactValue(key: string, value: unknown): unknown {
	if (SECRET_KEY_RE.test(key)) return "[redacted]";
	if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
		return `${value.slice(0, MAX_VALUE_CHARS)}…[${value.length} 字]`;
	}
	if (Array.isArray(value)) return value.slice(0, 20).map((item, index) => redactValue(`${key}.${index}`, item));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
			out[childKey] = redactValue(childKey, childValue);
		}
		return out;
	}
	return value;
}

/** 纯函数：把上下文里的敏感值抹掉、把长值截断 */
function redactLogContext(ctx: LogContext): LogContext {
	const out: LogContext = {};
	for (const [key, value] of Object.entries(ctx)) out[key] = redactValue(key, value);
	return out;
}

type LogEntry = {
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

type LoggerOptions = {
	level: LogLevel;
	scope?: string;
	now?: () => number;
	sink?: (line: string) => void;
};
/** 纯函数：把一条日志格式化成单行 JSON（脱敏与字段形状都在这一层定） */
function formatLogLine(entry: LogEntry): string {
	return JSON.stringify(entry.ctx ? entry : { ...entry, ctx: undefined });
}

export function createLogger(options: LoggerOptions): Logger {
	const now = options.now ?? (() => Date.now());
	const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
	const scope = options.scope ?? "app";
	const threshold = LEVEL_ORDER[options.level];

	const write = (level: LogLevel, message: string, ctx?: LogContext) => {
		if (LEVEL_ORDER[level] < threshold) return;
		const safeCtx = ctx ? redactLogContext(ctx) : undefined;
		sink(formatLogLine({ ts: now(), level, scope, msg: message, ...(safeCtx ? { ctx: safeCtx } : {}) }));
	};

	return {
		debug: (message, ctx) => write("debug", message, ctx),
		info: (message, ctx) => write("info", message, ctx),
		warn: (message, ctx) => write("warn", message, ctx),
		error: (message, ctx) => write("error", message, ctx),
		child: (childScope) => createLogger({ ...options, scope: `${scope}.${childScope}` }),
	};
}
