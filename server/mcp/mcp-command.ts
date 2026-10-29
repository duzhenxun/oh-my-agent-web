/**
 * 命令行解析的公共小工具：把「用户粘进来的一句话」拆成 command + args，并猜一个服务器名。
 *
 * 单独一个文件是因为两处都要用：添加表单（`mcp-import.ts` 拆粘贴内容）和
 * 市场条目（把市场给的命令行变成配置）。放谁那儿都会让另一个变成反向依赖。
 */
import { posix, win32 } from "node:path";

/**
 * 纯函数：把「未加引号、带空格的 Windows 绝对路径」重新拼回一个 token。
 *
 * 为什么需要：Windows 上「程序目录带空格」是**默认情况**（`C:\Program Files\nodejs\npx.cmd`），
 * 而用户从文档里粘过来一般不带引号。按空格切会把命令切成 `C:\Program` + `Files\nodejs\npx.cmd`，
 * 存进 mcp.json 就是一个永远跑不起来的配置。POSIX 上这条规则不会命中（没有盘符）。
 */
function mergeWindowsPaths(tokens: string[]): string[] {
	const absoluteWindows = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/;
	const out: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (!absoluteWindows.test(token)) {
			out.push(token);
			continue;
		}
		let merged = token;
		let next = index + 1;
		// 合并到「看起来已经是个可执行文件」或遇到下一个参数为止
		while (
			!/\.(exe|cmd|bat|com)$/i.test(merged) &&
			next < tokens.length &&
			!absoluteWindows.test(tokens[next] ?? "") &&
			!tokens[next]?.startsWith("-")
		) {
			merged += ` ${tokens[next]}`;
			next += 1;
		}
		out.push(merged);
		index = next - 1;
	}
	return out;
}

/**
 * 平台无关的「这是绝对路径吗」：两个系统都判。
 * 用户在 Windows 上粘 `C:\tools\npx.cmd`、在 mac 上粘 `/usr/bin/x` 都可能 —— 不能只用宿主平台那一套。
 */
function looksAbsolute(token: string): boolean {
	return win32.isAbsolute(token) || posix.isAbsolute(token);
}

/** 平台无关的「取最后一段」（`C:\a\b.exe` 与 `@scope/pkg` 都要能取） */
function lastSegment(token: string): string {
	return posix.basename(win32.basename(token));
}

/** `npx -y @scope/server-filesystem .` → 拆成词（引号里的空格不切，认单双引号） */
export function splitCommandLine(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const char of input.trim()) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") tokens.push(current);
	return mergeWindowsPaths(tokens);
}

/** 把一个字符串改成合法服务器名（非法字符换 `-`，全是非法就回退 `mcp`） */
export function sanitizeServerName(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return cleaned === "" ? "mcp" : cleaned;
}

/** 从命令 / url 猜一个服务器名（`@mcp/server-filesystem` → `filesystem`） */
export function deriveServerName(input: string): string {
	const trimmed = input.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const host = new URL(trimmed).hostname.replace(/^www\./, "");
			if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "localhost";
			const labels = host.split(".").filter((label) => label !== "");
			// 去掉 TLD（`com` / `dev`）与「这是个 MCP 服务」的通用前缀，
			// 取剩下里最靠后那段：`mcp.example.com` → `example`，`mcp.sentry.dev` → `sentry`。
			// 否则一堆服务器都会叫 mcp、mcp-2、mcp-3（名字要能认人才行）。
			const generic = new Set(["mcp", "mcp-server", "api", "server", "mcp-server-api"]);
			const withoutTld = labels.length > 1 ? labels.slice(0, -1) : labels;
			const meaningful = withoutTld.filter((label) => !generic.has(label.toLowerCase()));
			const pick = meaningful[meaningful.length - 1] ?? withoutTld[0] ?? "mcp";
			return sanitizeServerName(pick);
		} catch {
			return "mcp";
		}
	}
	const tokens = splitCommandLine(trimmed);
	// 从后往前找「像包名」的那一个：`npx -y @scope/pkg` / `uvx tools-mcp`。
	// 排除参数、绝对路径、`.`，以及没字母的（`--port 1` 里的 `1` 不是名字）。
	const candidate = [...tokens]
		.reverse()
		.find(
			(token) => !token.startsWith("-") && !looksAbsolute(token) && !token.startsWith(".") && /[A-Za-z]/.test(token),
		);
	// 一个都不像（比如 `C:\tools\x\server.exe --port 1`）：退回命令自己的文件名
	const base = lastSegment(candidate ?? tokens[0] ?? "mcp");
	return sanitizeServerName(
		base
			.replace(/^server-/, "")
			.replace(/^mcp-/, "")
			.replace(/\.(exe|cmd|bat|com|m?js|ts)$/i, ""),
	);
}

/**
 * 名字去重：`fake` 已存在就给 `fake-2`、`fake-3`…
 * （同一个 `mcp.json` 里同名会互相覆盖，静默吃掉用户原有配置是更糟的结果。）
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(name)) return name;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${name}-${index}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${name}-${Date.now()}`;
}
