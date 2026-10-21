/**
 * 命令行选项的「持久化兜底」：`<dataDir>/password` 与 `<dataDir>/allowed-hosts`。
 *
 * 为什么需要：`restart` 的参数是每次从命令行重新给的，忘了带 `-P` 就会把远程访问关掉
 * （真实踩过一次：重启后远程立刻 403「未设置 AGENT_WEB_PASSWORD」）。
 * 这两个文件让「设一次就一直在」，而命令行/环境变量仍然优先级最高。
 *
 * 纪律：读不到、读坏了都不致命 —— 没有密码文件就等同于「只允许本机」，和以前一致。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PASSWORD_FILE = "password";
export const ALLOWED_HOSTS_FILE = "allowed-hosts";

const readTrimmed = async (path: string): Promise<string | null> => {
	try {
		const text = await readFile(path, "utf8");
		// 只取第一行：顺手忽略编辑器留下的空行/换行，但密码里不允许出现空白
		const first = (text.split("\n")[0] ?? "").trim();
		return first === "" ? null : first;
	} catch {
		return null;
	}
};

export type StoredOptions = {
	password: string | null;
	allowedHosts: string[];
};

/** 纯读取：把两个文件都试一遍（不存在就给空值） */
export async function readStoredOptions(dataDir: string): Promise<StoredOptions> {
	const password = await readTrimmed(join(dataDir, PASSWORD_FILE));
	const rawHosts = await readFile(join(dataDir, ALLOWED_HOSTS_FILE), "utf8").catch(() => "");
	const allowedHosts = rawHosts
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return { password, allowedHosts };
}

/**
 * 把「存起来的选项」补进 env —— **只补缺**，命令行与环境变量优先。
 * 返回补了哪些（日志/提示用，绝不回显密码本身）。
 */
export async function applyStoredOptions(
	env: Record<string, string | undefined>,
	dataDir: string,
): Promise<{ password: boolean; allowedHosts: boolean }> {
	const stored = await readStoredOptions(dataDir);
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
