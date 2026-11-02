/**
 * 启动时**问一句**「要不要升级」（`aw upgrade` 的交互版）。
 *
 * 由来：update-check.ts 只会在启动那屏印一行「有新版本 → 升级：aw upgrade」，
 * 而升级是手动的 —— 没人愿意为了升级再单独去敲一条命令，于是提示看得见、版本永远不动。
 * 这里把它变成一次确认：**直接回车 = 升**，敲 `n` 才跳过。
 *
 * 四条纪律（和 update-check 一致，另外多两条）：
 *   1. **只在真终端里问**：非 TTY（CI / 被别的程序拉起 / `aw > log`）不问，退回那行被动提示；
 *   2. **问在「停 / 起」之前**：问在 `stop` 之后就白等一次完整重启了；
 *   3. **升完用新版重启**：重新 spawn 自己（带 `AGENT_WEB_UPGRADE_REEXEC=1`），
 *      而不是让旧 cli.js 去 import 新的 index.js —— 那样一个进程里会混两个版本；
 *   4. **升级失败绝不拦启动**：npm 不通 / 没权限，说一声就用当前版本继续起。
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { upgrade } from "./cli-info.js";
import { checkForUpdate } from "./update-check.js";

export type UpgradeOffer = {
	/** 真的把话问出去了吗（问过就不必再印那行被动提示） */
	asked: boolean;
	/** 已经交棒给新版了吗（true 时调用方应当直接 return，别再往下启动） */
	upgraded: boolean;
};

/** 「我是升完重启回来的」标记：同一个进程树里只问一次，不然升完又问、问了又升成环 */
const REEXEC_FLAG = "AGENT_WEB_UPGRADE_REEXEC";

const FALSEY = new Set(["off", "0", "false", "no"]);

/**
 * 这次要不要问（纯判断，好测）。
 *
 * 关掉的三种方式：`AGENT_WEB_UPDATE_PROMPT=off` / 不是 TTY / `CI` 里跑 ——
 * 后两种不是「用户不想要」，而是「没人能答」，问了就是卡住等一个永远不会来的回车。
 */
export function shouldPromptUpgrade(input: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	env: Record<string, string | undefined>;
}): boolean {
	const flag = (input.env.AGENT_WEB_UPDATE_PROMPT ?? "").trim().toLowerCase();
	if (FALSEY.has(flag)) return false;
	if (input.env[REEXEC_FLAG] === "1") return false;
	if (input.env.CI) return false;
	return input.stdinIsTTY && input.stdoutIsTTY;
}

/**
 * 回答怎么读：**回车 = 升级**（用户 2026-10-30 的要求），`n` / `no` / `不` 才跳过。
 *
 * 认不出的输入一律当成「不升级」：手滑打了个别的字符就替人装包，比多问一次糟糕得多。
 * `null`（Ctrl-C / EOF）同样不升级 —— 那时候人已经在急着启动了，不该顺手改他的环境。
 */
export function parseAnswer(answer: string | null, defaultYes = true): boolean {
	if (answer === null) return false;
	const text = answer.trim().toLowerCase();
	if (text === "") return defaultYes;
	return text === "y" || text === "yes" || text === "是" || text === "好" || text === "up";
}

/** 问一句，返回用户敲的内容；Ctrl-C / EOF 返回 null */
function ask(question: string): Promise<string | null> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			rl.close();
			// 关掉 readline 之后 stdin 还挂着监听就会吊住事件循环 —— 服务要起来，不能吊
			process.stdin.pause();
			resolve(value);
		};
		rl.once("SIGINT", () => finish(null));
		rl.once("close", () => finish(null));
		rl.question(question, (value) => finish(value));
	});
}

/** 换成新版重跑一遍同一条命令（旧进程立刻退出，终端/管道都接给子进程） */
function reexecInto(entry: string, argv: string[]): void {
	const child = spawn(process.execPath, [...process.execArgv, entry, ...argv], {
		stdio: "inherit",
		cwd: process.cwd(),
		env: { ...process.env, [REEXEC_FLAG]: "1" },
	});
	child.on("error", (error) => {
		console.error(`用新版重启失败（${error.message}）：手动再运行一次就行`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/** 同一个 CLI 进程里只会真问一次（restart 路径问完，start 路径再调也不重复问） */
let pending: Promise<UpgradeOffer> | null = null;

const NOT_ASKED: UpgradeOffer = { asked: false, upgraded: false };
/** 升完重启回来的那个进程：不用再问，也不用再补那行被动提示（人刚刚就在终端里答过） */
const ALREADY_ASKED: UpgradeOffer = { asked: true, upgraded: false };

async function runOffer(input: { dataDir: string; entry: string; argv: string[] }): Promise<UpgradeOffer> {
	// 1.5s 超时 + 6 小时缓存（见 update-check）：正常情况是「几乎立刻就答」或者「根本不用查」
	const result = await checkForUpdate({ dataDir: input.dataDir }).catch(() => null);
	if (!result?.hasUpdate) return NOT_ASKED;

	console.log(`\n  有新版本 v${result.latest}（当前 v${result.current}）`);
	const yes = parseAnswer(await ask("  现在升级吗？[Y/n] "));
	if (!yes) {
		console.log("  跳过升级，用当前版本启动（想升级随时 aw upgrade）\n");
		return { asked: true, upgraded: false };
	}

	const code = await upgrade({ quietTail: true });
	if (code !== 0) {
		// 网络 / 权限 / npm 不在都算「这条升级路走不通」，但启动这条路不该陪着一起断
		console.log("  升级没成功，继续用当前版本启动\n");
		return { asked: true, upgraded: false };
	}
	console.log("  正在用新版重新启动…\n");
	reexecInto(input.entry, input.argv);
	return { asked: true, upgraded: true };
}

/**
 * 该问就问：查一次新版，有的话确认一下，确认了就升级 + 交棒给新版进程。
 *
 * 调用方拿到 `upgraded: true` 要**直接 return**（这个进程已经不需要再做什么了）。
 */
export function offerUpgrade(input: { dataDir: string; entry: string; argv: string[] }): Promise<UpgradeOffer> {
	// 升级后重启回来的：问过、也决策过了，只把「别再印被动提示」这个事实传下去
	if (process.env[REEXEC_FLAG] === "1") return Promise.resolve(ALREADY_ASKED);
	const interactive = shouldPromptUpgrade({
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
		env: process.env,
	});
	if (!interactive) return Promise.resolve(NOT_ASKED);
	pending ??= runOffer(input);
	return pending;
}
