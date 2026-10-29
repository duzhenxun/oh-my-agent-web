/**
 * 跨平台启动外部 CLI（codex / dsh / opencode / npx …）。
 *
 * 为什么需要单独一个模块：**Windows 上 npm 全局安装出来的不是可执行文件**，而是
 * `codex.cmd` / `npx.cmd` 这类批处理 shim。CreateProcess 不能直接执行批处理，而
 * Node ≥ 18.20（本项目要求 ≥22.19）为修 CVE-2024-27980 明确拒绝「不带 shell 启动
 * `.cmd`/`.bat`」—— 直接抛 `EINVAL`。所以这里分两步：
 *
 *   1. 先按 PATH + PATHEXT 解析出真实文件（`opencode` → `…\opencode.cmd`）；
 *   2. 是 `.exe`/`.com` 就原样 spawn，否则经 `cmd.exe /d /s /c` 起。
 *
 * 转义规则**照抄 cross-spawn**（它照着 https://qntm.org/cmd 里 cmd 的两遍解析怪癖
 * 推出来的，自己发明一套必然在某个引号/元字符上翻车）。两处细节容易漏：
 *   - 命令路径要先做 Windows 归一化（`/` → `\`），否则 cmd 找不到文件；
 *   - `node_modules/.bin` 里的 cmd-shim 会被 cmd 再解析一遍，元字符必须**双重**转义。
 *
 * 全部是纯函数：平台与 PATH 都是参数，不依赖真实运行环境。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

type ResolvedCli = {
	file: string;
	args: string[];
	/** 直接展开进 `spawn` 的选项：Windows 下永久关黑窗，经 cmd.exe 时必须 verbatim */
	options: { windowsHide: boolean; windowsVerbatimArguments?: true };
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** npm 的 cmd-shim 目录：这里的 shim 会把参数再交给一次 cmd，元字符要双转义 */
const CMD_SHIM = /node_modules[\\/]\.bin[\\/]/;

/** 批处理：永远不能直接 spawn（CreateProcess 不认，Node ≥18.20 还会主动抛 EINVAL） */
const BATCH = /\.(cmd|bat)$/i;

/** cmd.exe 眼里的元字符（`^` 转义用） */
const META = /([()[\]%!^"`<>&|;, *?])/g;

/** PATH 列表切分：Windows 用 `;`，POSIX 用 `:`（Windows 上也存在只设 `Path` 的环境） */
function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	const raw = env.PATH ?? env.Path ?? "";
	return raw
		.split(platform === "win32" ? ";" : ":")
		.map((dir) => dir.trim())
		.filter((dir) => dir !== "");
}

/** Windows 上按 PATHEXT 逐个试扩展名（`npx` → `npx.cmd`）；POSIX 上不试 */
function suffixesOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return [""];
	const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT)
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension !== "")
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
	return ["", ...extensions];
}

/**
 * 在 PATH 里找可执行文件；找不到返回 `null`。
 * 带分隔符的（`C:\tools\codex.cmd` / `./bin/x`）只看它自己，不搜 PATH。
 */
export function findExecutable(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): string | null {
	// join 也要跟着平台走：宿主是 POSIX 时 path.join 会把 `C:\a` 拼成 `C:\a/b`
	const joiner = platform === "win32" ? win32 : posix;
	const hasDir = bin.includes("/") || bin.includes("\\");
	const dirs = hasDir ? [""] : pathDirs(env, platform);
	const suffixes = suffixesOf(env, platform);
	for (const dir of dirs) {
		const base = dir === "" ? bin : joiner.join(dir, bin);
		for (const suffix of suffixes) {
			const candidate = suffix === "" ? base : `${base}${suffix}`;
			try {
				if (exists(candidate)) return candidate;
			} catch {
				// 非法路径（含 Windows 不允许的字符）就当没有，继续找下一个
			}
		}
	}
	return null;
}

/** 命令本身：路径里的空格/元字符必须先转义，否则被 cmd 当分隔符吃掉 */
function escapeCommand(command: string): string {
	return command.replace(META, "^$1");
}

/**
 * 单个参数：反斜杠+引号加倍 → 整体加引号 → 元字符加 `^`。
 *
 * `doubleEscape` 只对 `node_modules/.bin` 里的 cmd-shim 为真：那层 shim 会把参数
 * 再交给一次 cmd，单层转义在那里会被吃掉一层。
 */
function escapeArgument(argument: string, doubleEscape: boolean): string {
	// 用「前瞻 + 反向引用」而不是贪婪匹配：避免在构造出来的长反斜杠上回溯到卡死
	// （cross-spawn 因这一条专门修过 https://github.com/moxystudio/node-cross-spawn/pull/160）
	let value = String(argument).replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
	value = value.replace(/(?=(\\+?)?)\1$/, "$1$1");
	let quoted = `"${value}"`.replace(META, "^$1");
	if (doubleEscape) quoted = quoted.replace(META, "^$1");
	return quoted;
}

/**
 * 把「像 npm 全局命令那样的 bin」变成可以直接 spawn 的形态。
 *
 * POSIX 上原样返回；Windows 上解析 PATHEXT，`.cmd`/`.bat` 改走 `cmd.exe /d /s /c "…"`。
 */
export function resolveCli(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): ResolvedCli {
	if (platform !== "win32") return { file: bin, args, options: { windowsHide: false } };

	// 找不到实体文件时用原名字：非 .cmd 会直接 spawn 并报 `spawn xxx ENOENT`
	// （比 cmd 那句「不是内部或外部命令」好搜，也和 POSIX 上的报错一致）
	const command = win32.normalize(findExecutable(bin, env, platform, exists) ?? bin);
	if (!BATCH.test(command)) return { file: command, args, options: { windowsHide: true } };

	const line = [escapeCommand(command), ...args.map((arg) => escapeArgument(arg, CMD_SHIM.test(command)))].join(" ");
	return {
		// /d 跳过 AutoRun 注册表项（别人的 bat 会改行为）、/s 保持引号原样、/c 执行
		file: env.COMSPEC ?? env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		options: { windowsHide: true, windowsVerbatimArguments: true },
	};
}

/**
 * 「跑一行命令」用的 shell（MCP 配置里的 `${VAR}` / `!cmd` 走这条路）。
 * Windows 是 `cmd.exe /c`，POSIX 坚持 `/bin/sh -c`（不用 $SHELL：这里要的是 sh 语义）。
 */
export function shellCommand(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
	if (platform === "win32") return { file: env.COMSPEC ?? env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
	return { file: "/bin/sh", args: ["-c", command] };
}

/**
 * 杀掉子进程**连同它拉起的整棵树**。
 *
 * Windows 上没有进程组、也没有可捕获的 SIGTERM（`kill` 被映射成 TerminateProcess，
 * 只杀直接子进程）。而经 cmd.exe 启动的 `.cmd` 还会再拉一层 node —— 必须请
 * `taskkill /T /F` 出手，否则引擎子进程会变成孤儿一直挂在那儿。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child.pid === undefined) return;
	if (process.platform !== "win32") {
		child.kill(signal);
		return;
	}
	try {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => child.kill());
	} catch {
		child.kill();
	}
}
