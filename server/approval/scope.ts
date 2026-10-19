/**
 * 「这类操作」的归类（ADR-0006 审批粒度）。
 *
 * ADR-0006 的原话：「这类」= 工具名 + 一个稳定特征：命令类取**可执行名**，文件类取**目标目录**
 * （不用完整命令行，否则永远命中不了）。
 *
 * 全部是纯函数：给定工具名与参数，产出
 *   - `dangerous`：要不要问（读类不问，写/改/跑命令要问）
 *   - `scopeHint`：落到规则文件里的稳定键
 *   - `riskNote`：给人看的一句话（为什么问）
 */
import { isAbsolute, join, resolve } from "node:path";
import { isReadOnlyCommand } from "./read-only.js";

export type ApprovalScope = {
	dangerous: boolean;
	toolName: string;
	/** 稳定键：`<tool>|<特征>`，例如 `bash|npm`、`write|/repo/docs` */
	scopeKey: string;
	/** 给人看的「这类」描述，例如 `命令 npm`、`目录 /repo/docs` */
	scopeHint: string;
	riskNote: string;
	/** 给界面用的参数摘要（截断） */
	argsSummary: string;
};

/** 不问的工具：只读类 */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const SUMMARY_CHARS = 200;

const RISK_NOTES: Record<string, string> = {
	bash: "跑命令会修改你的机器（装包、删文件、改配置都算），确认后才能执行",
	write: "写文件会改动磁盘内容，确认后才能执行",
	edit: "改文件会改动已有内容，确认后才能执行",
	powershell: "跑 PowerShell 命令会修改你的机器，确认后才能执行",
};

function truncate(text: string, limit = SUMMARY_CHARS): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 包装命令（跳过它们去找真正的可执行名） */
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "nice", "stdbuf"]);
/** 这些选项后面还跟一个值（`sudo -u root …`）—— 跳选项时要一起跳 */
const VALUE_OPTIONS = new Set([
	"-u",
	"-g",
	"-p",
	"-C",
	"-h",
	"-U",
	"-T",
	"-r",
	"-t",
	"--user",
	"--group",
	"--prompt",
	"--host",
	"--chdir",
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 从命令行里取「可执行名」：跳过 `FOO=bar` 环境赋值、`sudo`/`env`/`nohup` 之类包装（含它们的选项与取值）、
 * 以及路径前缀。
 * 例：`FOO=1 npm run build` → `npm`；`sudo -u root npm ci` → `npm`；`/usr/bin/git push -f` → `git`
 */
export function commandExecutable(command: string): string {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	let index = 0;

	skipLeading: for (;;) {
		const token = tokens[index];
		if (token === undefined) break;
		if (ENV_ASSIGNMENT_RE.test(token)) {
			index += 1;
			continue;
		}
		if (WRAPPERS.has(token)) {
			index += 1;
			// 跳过包装命令自己的选项与取值（`sudo -u root` 里的 `-u root`）
			while (index < tokens.length) {
				const next = tokens[index];
				if (ENV_ASSIGNMENT_RE.test(next)) {
					index += 1;
					continue;
				}
				if (!next.startsWith("-")) break;
				index += VALUE_OPTIONS.has(next) ? 2 : 1;
			}
			continue skipLeading;
		}
		break;
	}

	const token = tokens[index] ?? "";
	const base = token.split(/[\\/]/).pop() ?? token;
	return base === "" ? "(空命令)" : base;
}

/** 目标路径所在目录（相对路径按工作区根解析） */
export function targetDirectory(path: string, workspace: string): string {
	if (path === "") return workspace;
	const absolute = isAbsolute(path) ? path : resolve(join(workspace, path));
	const index = absolute.lastIndexOf("/");
	return index <= 0 ? absolute : absolute.slice(0, index);
}

export type ScopeInput = {
	toolName: string;
	args: unknown;
	workspace: string;
};

/** 从工具调用参数里抠出最有信息量的那个字段（不同工具的 schema 不同，这里只做尽力而为） */
function pickString(args: unknown, keys: string[]): string | null {
	if (typeof args !== "object" || args === null) return null;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return null;
}

export function classifyScope(input: ScopeInput): ApprovalScope {
	const { toolName, args, workspace } = input;
	const dangerous = !READ_ONLY_TOOLS.has(toolName);
	const argsSummary = truncate(typeof args === "string" ? args : JSON.stringify(args ?? {}));

	if (toolName === "bash" || toolName === "powershell") {
		const command = pickString(args, ["command", "cmd", "script"]) ?? "";
		const executable = commandExecutable(command);
		// 纯读命令（sed -n / grep / cat …）不问：把"闭眼允许"的口子关掉
		if (isReadOnlyCommand(command)) {
			return {
				dangerous: false,
				toolName,
				scopeKey: `${toolName}|${executable}`,
				scopeHint: `命令 ${executable}`,
				riskNote: "",
				argsSummary: truncate(command),
			};
		}
		return {
			dangerous,
			toolName,
			scopeKey: `${toolName}|${executable}`,
			scopeHint: `命令 ${executable}`,
			riskNote: RISK_NOTES[toolName] ?? "这条命令会改动你的机器，确认后才能执行",
			argsSummary: truncate(command || argsSummary),
		};
	}

	const path = pickString(args, ["path", "file", "filePath", "target"]);
	if (path) {
		const directory = targetDirectory(path, workspace);
		return {
			dangerous,
			toolName,
			scopeKey: `${toolName}|${directory}`,
			scopeHint: `目录 ${directory}`,
			riskNote: RISK_NOTES[toolName] ?? "这个操作会改动磁盘内容，确认后才能执行",
			argsSummary,
		};
	}

	return {
		dangerous,
		toolName,
		scopeKey: `${toolName}|*`,
		scopeHint: `所有 ${toolName} 调用`,
		riskNote: RISK_NOTES[toolName] ?? "这个操作有副作用，确认后才能执行",
		argsSummary,
	};
}
