/**
 * 引擎版本探测（切换面板上**每一项**都要显示自己的版本号，不只是当前那个）。
 *
 * 为什么不去问引擎自己：除了 pi（SDK 导出 `VERSION`）和 fake，其余引擎的版本号都是
 * **握手时**给的（ACP 的 `agentInfo.version`、codex 的 `userAgent`）。要拿到握手结果就得
 * 起一个子进程 —— 为了一行小字把 codex app-server / claude-code-acp 全拉起来，代价远大于
 * 收益（codex 还会抢会话写锁、ACP 适配器要读一遍用户配置）。所以这里只做两件便宜事：
 *
 *   1. 跑一次 `<bin> --version`（dsh / opencode / codex 都认），带超时，输出里挑版本号；
 *   2. ACP 适配器（claude-code-acp）**不认** `--version`（它会直接去握手），那就读它
 *      bin 旁边的 `package.json` —— 面板上要显示的就是这个适配器版本（实测 0.16.2 与
 *      握手给的 `agentInfo.version` 一致，换引擎前后是同一个数，不会跳）。
 *
 * 拿不到就返回 null：界面少一行字，绝不编一个版本号。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { findExecutable, killTree, resolveCli } from "../util/spawn-cli.js";

/** `codex-cli 0.162.1`、`0.2.0-rc.2`、`v1.19.0` 都能挑出来 */
const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/** 版本探测超时：拿不到就当没有，不让面板等它 */
const DEFAULT_TIMEOUT_MS = 4000;

/** 从一整行输出里挑出版本号本体（`codex-cli 0.162.1` → `0.162.1`）；没有就 null */
function parseVersionText(text: string): string | null {
	const match = VERSION_RE.exec(text ?? "");
	return match ? match[0] : null;
}

/**
 * 读 `<bin>` 所属 npm 包的 `package.json` 版本（同步、不开子进程）。
 *
 * 做法：解析出真实文件路径（`…/bin/claude-code-acp` 是指向
 * `…/lib/node_modules/@zed-industries/claude-code-acp/dist/index.js` 的软链），
 * 然后**从它所在目录往上**找最近的 package.json。找不到返回 null。
 *
 * Windows 上 npm 装出来的 `claude-code-acp.cmd` 是个 shim（不是软链），往上找不到包，
 * 这里就返回 null —— 那种情况界面只显示名字，不显示错版本号。
 */
export function probePackageVersion(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
): string | null {
	const resolved = findExecutable(bin, env, process.platform, exists) ?? bin;
	let file: string;
	try {
		file = realpathSync(resolved);
	} catch {
		return null;
	}
	let dir = dirname(file);
	for (let depth = 0; depth < 6; depth += 1) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
				if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version.trim();
			} catch {
				// 坏 JSON / 读不了：继续往上找，别把整个探测搞挂
			}
			return null; // 最近的 package.json 都没有版本号：再往上只会找到别人的
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * 跑 `<bin> --version` 并挑出版本号；超时 / 没装 / 不认这个参数都返回 null。
 *
 * 杀进程走 `killTree`：Windows 上经 cmd.exe 起的 `.cmd` 会再拉一层 node，只杀直接子进程
 * 会留孤儿（见 util/spawn-cli.ts）。
 */
export function probeCliVersion(
	bin: string,
	options: { args?: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
	const args = options.args ?? ["--version"];
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const env = options.env ?? process.env;
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			const resolved = resolveCli(bin, args, env);
			child = spawn(resolved.file, resolved.args, {
				...resolved.options,
				// stdin 给 null：`--version` 之后还等输入的实现（claude-code-acp）能立刻退出
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve(null);
			return;
		}
		const timerId = setTimeout(() => {
			killTree(child);
			finish(null);
		}, timeoutMs);
		timer = timerId;
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		// 有的 CLI 把版本打到 stderr
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", () => finish(null));
		child.on("close", () => finish(parseVersionText(output)));
	});
}
