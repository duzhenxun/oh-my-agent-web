/**
 * Agent Computer helper 的路径约定（与其源码 TurboCore/Paths.swift、paths.mjs 保持一致）。
 *
 * 现在有两条路：
 *   - **内嵌二进制**（默认）：oh-my-agent-web.app 的 Resources/helper/agent-computer/agent-computer
 *     （Windows 上是 `agent-computer.exe`），由服务端 spawn，用 stdio 帧通信；用户不用再单独安装 .app。
 *   - **旧 .app + Unix socket**：已安装的 macOS 用户继续可用，找不到内嵌二进制时自动回落。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HELPER_APP_NAME = "Agent Computer.app";

/** helper 的数据目录：设置文件、允许名单、socket 都在这里 */
export function supportDir(home: string = homedir()): string {
	return join(home, "Library", "Application Support", "AgentComputer");
}

export function socketPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return env.CUT_SOCKET_PATH?.trim() || join(supportDir(home), "agent-computer.sock");
}

/**
 * 内嵌 helper 的文件名。
 *
 * 目前只有 macOS 实现（Swift），所以只有裸二进制一个名字。
 * Windows 版**还没做**（2026-11-24 用户决定：先不做，界面显示「敬请期待」）——
 * 将来如果加 Windows 实现，`agent-computer.exe` 与 `release-win/` 这套区分要在这里补回来，
 * 别在别处按 `process.platform` 散着判断。
 */
export function helperBinaryName(): string {
	return "agent-computer";
}

/** 开发态产物目录名（构建产物，`release/` 在 .gitignore 里） */
export function helperReleaseDirName(): string {
	return "release";
}

/**
 * 内嵌 helper 裸二进制；找不到返回 null（调用方据此回落旧 socket）。
 *
 * 按代码位置往上找：编译后是 `<pkg>/dist/server/computer`，往上三级是包根；
 * 开发态是 `<repo>/server/computer`，往上两级是仓库根（`release/` / `release-win/` 是构建产物）。
 *
 * `AGENT_COMPUTER_BINARY` 留给调试 / 非标准安装位置。
 */
export function helperBinaryPath(env: NodeJS.ProcessEnv = process.env): string | null {
	const override = env.AGENT_COMPUTER_BINARY?.trim();
	if (override) return existsSync(override) ? override : null;

	const name = helperBinaryName();

	const releaseDir = helperReleaseDirName();
	const here = dirname(fileURLToPath(import.meta.url));
	for (const root of [resolve(here, "..", "..", ".."), resolve(here, "..", "..")]) {
		const candidate = join(root, "helper", "agent-computer", releaseDir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export type HelperTransport = "stdio" | "socket";

/**
 * 选传输：显式 `AGENT_COMPUTER_TRANSPORT=socket` 优先（旧行为 / 排障），
 * 否则有内嵌二进制就走 stdio，没有才回落 socket。
 *
 * Windows 上没有旧 .app：内嵌 exe 找不到时这条回落路径实际不可用（socket 路径是 macOS 的约定），
 * status.ts 会据此把 `supported` 判成 false。传输层本身不用改 —— 帧协议两端一致。
 */
export function helperTransport(
	env: NodeJS.ProcessEnv = process.env,
	binary: string | null = helperBinaryPath(env),
): HelperTransport {
	const explicit = env.AGENT_COMPUTER_TRANSPORT?.trim().toLowerCase();
	if (explicit === "socket" || explicit === "stdio") return explicit;
	return binary ? "stdio" : "socket";
}

export function settingsPath(home: string = homedir()): string {
	return join(supportDir(home), "settings.json");
}

export function allowProtectedPath(home: string = homedir()): string {
	return join(supportDir(home), "allow-protected.txt");
}

/**
 * helper 的下载地址：**项目仓库里那份 zip**（不走 npm 包，包体积 + Gatekeeper 都不划算）。
 *
 * 2026-11-24 用户拍定：电脑控制就走「用户自己装 Agent Computer.app」这条路，
 * 不把 helper 内嵌进 oh-my-agent-web（那样等于把两件东西的版本、签名、权限捆在一起）。
 * 所以这里保留下载入口，面板据此给「下载 Agent Computer.app」按钮。
 * 可用 `AGENT_COMPUTER_DOWNLOAD_URL` 覆盖（内网镜像 / 自己编译）。
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
