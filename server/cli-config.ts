/**
 * 命令行选项的「持久化兜底」：`<dataDir>/password` 与 `<dataDir>/allowed-hosts`。
 *
 * 为什么需要：`restart` 的参数是每次从命令行重新给的，忘了带 `-P` 就会把远程访问关掉
 * （真实踩过一次：重启后远程立刻 403「未设置 AGENT_WEB_PASSWORD」）。
 * 这两个文件让「设一次就一直在」。
 *
 * **密码以文件为准**（用户 2026-10-30）：「设置 → 远程」写的是文件，若环境变量优先，
 * 改动就会被静默盖掉 —— 重启后远程登录变成「密码怎么变了」。所以 `AGENT_WEB_PASSWORD` /
 * `-P` 只在文件还没生成时当一次性来源，落地后一律读文件（见 `resolveStartupPassword`）。
 *
 * 纪律：读不到、读坏了都不致命 —— 没有密码文件就等同于「只允许本机」，和以前一致。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PASSWORD_FILE = "password";
const ALLOWED_HOSTS_FILE = "allowed-hosts";

type StoredOptions = {
	password: string | null;
	allowedHosts: string[];
};

/** 同步读（服务入口在 `readConfig` **之前**就要用到，那时还没法 await） */
function readStoredOptionsSync(dataDir: string): StoredOptions {
	const readTrimmedSync = (path: string): string | null => {
		try {
			const first = (readFileSync(path, "utf8").split("\n")[0] ?? "").trim();
			return first === "" ? null : first;
		} catch {
			return null;
		}
	};
	let rawHosts = "";
	try {
		rawHosts = readFileSync(join(dataDir, ALLOWED_HOSTS_FILE), "utf8");
	} catch {
		rawHosts = "";
	}
	return {
		password: readTrimmedSync(join(dataDir, PASSWORD_FILE)),
		allowedHosts: rawHosts
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter((item) => item !== ""),
	};
}

/**
 * 把「存起来的选项」补进 env —— **只补缺**，命令行与环境变量优先。
 * 返回补了哪些（日志/提示用，绝不回显密码本身）。
 *
 * 两个入口都要调：`cli.ts`（`aw` / `npm start`）与 `index.ts`（`npm run dev` / `npm run serve`）。
 * 以前只有前者调，于是「源码起」完全无视在「设置 → 远程」里设的密码（写的是文件、读的只有环境变量），
 * 重启后远程登录就成了「密码怎么变了」（用户 2026-10-30）。
 */
export function applyStoredOptions(
	env: Record<string, string | undefined>,
	dataDir: string,
): { password: boolean; allowedHosts: boolean } {
	const stored = readStoredOptionsSync(dataDir);
	let password = false;
	let allowedHosts = false;
	if (stored.password && !env.AGENT_WEB_PASSWORD) {
		env.AGENT_WEB_PASSWORD = stored.password;
		password = true;
	}
	if (stored.allowedHosts.length > 0 && !env.AGENT_WEB_ALLOWED_HOSTS) {
		env.AGENT_WEB_ALLOWED_HOSTS = stored.allowedHosts.join(",");
		allowedHosts = true;
	}
	return { password, allowedHosts };
}
