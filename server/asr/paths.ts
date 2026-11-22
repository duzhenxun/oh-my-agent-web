/**
 * 本地识别程序的「装在哪」与「从哪拿」。
 *
 * 为什么不直接跑仓库/依赖包里那份（踩过的坑）：
 *   - macOS 的 TCC（隐私授权）认的是 **.app 的签名（cdhash）**。npm 升级会整包替换
 *     `node_modules`，包里那份每次升级都是新文件 → 系统当成新程序，每次升级重新弹一次
 *     「允许访问语音识别」。装到 `Application Support` 之后升级不动它，只问一次；
 *   - 全局安装时包目录可能属于 root，写它要 sudo；包管理器本来也会覆盖它 ——
 *     依赖目录不能当安装位。
 *
 * 分发方式沿用 helper/agent-computer 那套：**安装包（预编译过的 .app 的 zip）放仓库**，
 * 服务端给下载地址，用户点一下自动装。npm 包里也带一份同样的 zip 当离线后备
 * （GitHub raw 在某些网络里很慢或连不上，npm registry 通常还能到）。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ASR_APP_NAME = "ASRBridge.app";

/** 安装目录：`~/Library/Application Support/oh-my-agent-web/asr`（`OH_MY_AGENT_ASR_DIR` 可覆盖，测试用） */
export function asrSupportDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OH_MY_AGENT_ASR_DIR?.trim();
	if (override) return override;
	return join(home, "Library", "Application Support", "oh-my-agent-web", "asr");
}

/** 装好之后 .app 的绝对路径 */
export function installedAppPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	return join(asrSupportDir(home, env), ASR_APP_NAME);
}

/**
 * 包里（或仓库里）自带的 helper 目录：`dist/server/asr/` 与源码 `server/asr/` 深度不同，
 * 从近到远各试一次；npm 安装后布局和仓库一致，所以两条都成立。找不到返回 null。
 */
export function bundledHelperDir(): string | null {
	const candidates = [
		new URL("../../../helper/asr/", import.meta.url), // dist/server/asr → 包根
		new URL("../../helper/asr/", import.meta.url), // server/asr → 仓库根
	];
	for (const candidate of candidates) {
		const dir = fileURLToPath(candidate);
		if (existsSync(dir)) return dir;
	}
	return null;
}

/** 仓库里 `./helper/asr/build.sh` 的产物（开发机直接从源码跑时就用它，不必再装一份） */
export function bundledAppPath(): string | null {
	const dir = bundledHelperDir();
	if (dir === null) return null;
	const app = join(dir, ASR_APP_NAME);
	return existsSync(app) ? app : null;
}

/** 随 npm 包一起发的预编译 zip */
export function bundledZipPath(): string | null {
	const dir = bundledHelperDir();
	if (dir === null) return null;
	const zip = join(dir, "release", "ASRBridge.zip");
	return existsSync(zip) && statSync(zip).isFile() ? zip : null;
}

/**
 * 「用哪份 .app」的纯函数版（单测直接调，不碰真实文件系统）。
 *
 * 顺序：显式指定 > 装到 Application Support 的那份 > 仓库里 build.sh 的产物。
 * 都没有时回**安装目标路径** —— 报错文案里的路径和用户该放东西的地方是同一个。
 */
export function pickAsrAppPath(facts: {
	override?: string | null;
	installed: string;
	installedExists: boolean;
	bundled: string | null;
}): string {
	const override = facts.override?.trim();
	if (override) return override;
	if (facts.installedExists) return facts.installed;
	if (facts.bundled !== null) return facts.bundled;
	return facts.installed;
}

/** 按当前环境找 ASRBridge.app（桥每次启动都调一次：装完不用重启服务） */
export function resolveAsrAppPath(): string {
	const installed = installedAppPath();
	return pickAsrAppPath({
		override: process.env.OH_MY_AGENT_ASR_APP,
		installed,
		installedExists: existsSync(installed),
		bundled: bundledAppPath(),
	});
}

/**
 * 安装包的下载地址。
 *
 * `.app` 没做开发者签名（ad-hoc 而已），所以不走 npm 包内分发当主路径 ——
 * 预编译好的 zip 直接放在仓库里（`helper/asr/release/`），改完 helper 跑一次
 * `./helper/asr/build.sh --release` 就会更新它。可用 `OH_MY_AGENT_ASR_DOWNLOAD_URL` 覆盖。
 */
export function asrDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OH_MY_AGENT_ASR_DOWNLOAD_URL?.trim();
	if (override) return override;
	return "https://github.com/duzhenxun/oh-my-agent-web/raw/main/helper/asr/release/ASRBridge.zip";
}
