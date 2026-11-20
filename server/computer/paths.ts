/**
 * macOS 上 Agent Computer helper 的路径约定（与其源码 TurboCore/Paths.swift、paths.mjs 保持一致）。
 *
 * helper 是另一个原生 App，由用户自己从源码编译安装；这里只负责找到它、连上它、读写它的配置文件。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HELPER_APP_NAME = "Agent Computer.app";

/** helper 的数据目录：设置文件、允许名单、socket 都在这里 */
export function supportDir(home: string = homedir()): string {
	return join(home, "Library", "Application Support", "AgentComputer");
}

export function socketPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return env.CUT_SOCKET_PATH?.trim() || join(supportDir(home), "agent-computer.sock");
}

export function settingsPath(home: string = homedir()): string {
	return join(supportDir(home), "settings.json");
}

export function allowProtectedPath(home: string = homedir()): string {
	return join(supportDir(home), "allow-protected.txt");
}

/**
 * helper 的下载地址。
 *
 * 没做开发者签名，所以不走 npm 包内分发（包体积 + Gatekeeper 拦截），
 * 改成让用户从 Releases 下载 .app。可以用 `AGENT_COMPUTER_DOWNLOAD_URL` 覆盖。
 */
export function helperDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.AGENT_COMPUTER_DOWNLOAD_URL?.trim();
	if (override) return override;
	// .app 的 zip 直接放在仓库里（helper/agent-computer/release/），
	// 不需要 Releases / CI：改完 helper 跑一次 build-app.sh 就会更新这个文件。
	return "https://github.com/duzhenxun/oh-my-agent-web/raw/main/helper/agent-computer/release/Agent%20Computer.zip";
}

/**
 * 找到已安装的 helper：`CUT_HELPER_APP` 优先（指向不存在时直接返回 null，不静默回退），
 * 否则查 `~/Applications` 与 `/Applications`。
 */
export function findHelperApp(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
	const override = (env.AGENT_COMPUTER_APP ?? env.CUT_HELPER_APP)?.trim();
	if (override) return existsSync(override) ? override : null;
	for (const candidate of [join(home, "Applications", HELPER_APP_NAME), join("/Applications", HELPER_APP_NAME)]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
