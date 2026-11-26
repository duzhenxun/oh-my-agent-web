/**
 * 一键安装 helper：服务端自己下载 zip → 解压 → 放进「应用程序」→ 打开。
 *
 * 为什么不让用户从浏览器下载：浏览器下的 zip 会被打上 `com.apple.quarantine`，
 * 解压出来的 `.app` 会被 Gatekeeper 拦（「Apple 无法验证…」）。而**新版 macOS 已经
 * 不允许用「右键 → 打开」绕过**，用户必须去「系统设置 → 隐私与安全性」底部点
 * 「仍要打开」，再确认一次 —— 四步操作，且每一步都长得像"出事了"。
 *
 * 服务端用 `fetch` 下载的文件**不带**隔离标记（只有浏览器/Safari 会加），
 * 解压后直接可以运行。这不是绕过安全检查，而是让「用户明确点了一次安装按钮」
 * 这件事本身就构成那次确认。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findHelperApp, helperDownloadUrl, socketPath } from "./paths.js";

const run = promisify(execFile);

/** helper zip 不到 1MB，给 3 分钟足够；卡住不收就是事故 */
const DOWNLOAD_TIMEOUT_MS = 180_000;
const APP_NAME = "Agent Computer.app";
/** 解压后的可执行文件（相对 .app 根）：用来确认这份包是完整的 */
const APP_BINARY = "Contents/MacOS/AgentComputer";
/** 小到不可能是安装包（防止把 404 页面当成 zip 存下来） */
const MIN_ARCHIVE_BYTES = 100_000;

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

export type InstallHelperResult = { ok: true; appPath: string; message: string } | { ok: false; message: string };

/** `/Applications` 写不进去（非管理员/受管机器）就退到 `~/Applications` */
function pickTargetDir(): string {
	const system = "/Applications";
	try {
		accessSync(system, constants.W_OK);
		return system;
	} catch {
		const userDir = join(homedir(), "Applications");
		mkdirSync(userDir, { recursive: true });
		return userDir;
	}
}

async function downloadTo(url: string, dest: string): Promise<number> {
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}（${url}）`);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length < MIN_ARCHIVE_BYTES) {
		throw new Error(`下载到的内容只有 ${buffer.length} 字节，不像是安装包（可能被代理/镜像拦截了）`);
	}
	writeFileSync(dest, buffer);
	return buffer.length;
}

/**
 * 下载并安装 helper，装完直接打开它（首次打开会弹出权限引导窗口）。
 *
 * 不自己猜"要不要覆盖"：用户点安装就是要最新那份，所以先停掉旧进程再整份替换。
 */
export async function installHelper(log?: Logger): Promise<InstallHelperResult> {
	if (process.platform !== "darwin") {
		return { ok: false, message: "电脑控制只有 macOS 版（其余平台没有 Accessibility 这套接口）" };
	}

	const tmp = mkdtempSync(join(tmpdir(), "oh-my-agent-web-helper-"));
	try {
		const zipPath = join(tmp, "helper.zip");
		const bytes = await downloadTo(helperDownloadUrl(process.env), zipPath);

		const outDir = join(tmp, "out");
		mkdirSync(outDir, { recursive: true });
		// ditto 而不是 unzip：保住可执行位、签名与资源分支（解开后还要能跑）
		await run("ditto", ["-x", "-k", zipPath, outDir]);

		const staged = join(outDir, APP_NAME);
		if (!existsSync(join(staged, APP_BINARY))) {
			throw new Error("解压后没找到 AgentComputer 可执行文件，安装包可能不完整");
		}

		const targetDir = pickTargetDir();
		const dest = join(targetDir, APP_NAME);
		// 旧版本可能正在跑：先停（pkill 找不到进程会非零退出，忽略）
		await run("pkill", ["-f", dest]).catch(() => undefined);
		rmSync(dest, { recursive: true, force: true });
		await run("ditto", [staged, dest]);
		// 保险：万一镜像/代理那边带了隔离属性
		await run("xattr", ["-dr", "com.apple.quarantine", dest]).catch(() => undefined);

		// 装完直接开：权限引导窗口只有它自己能弹
		await run("open", ["-a", dest]).catch((error: unknown) => {
			log?.warn("helper 已装好但没能自动打开", {
				message: error instanceof Error ? error.message : String(error),
			});
		});

		log?.warn("helper 已安装", { appPath: dest, bytes });
		return { ok: true, appPath: dest, message: `已安装到 ${dest}，按窗口提示授权即可` };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * 启动已装好的 helper（不碰安装内容）。
 *
 * 为什么需要它：helper 是「装了但可能没在跑」的独立 app —— 用户关掉了、
 * 或系统登录项没配、或它自己崩了，面板上就只剩一条 `connect ENOENT …sock`。
 * 让用户自己去 Finder 里翻 app 太蠢，这里给一颗按钮。
 */
export async function startHelper(log?: Logger): Promise<{ ok: boolean; message: string; appPath?: string }> {
	if (process.platform !== "darwin") {
		return { ok: false, message: "电脑控制只有 macOS 版" };
	}
	const appPath = findHelperApp(process.env);
	if (!appPath) {
		return { ok: false, message: "还没安装 Agent Computer，先点「一键安装」" };
	}

	try {
		await run("open", ["-a", appPath]);
	} catch (error) {
		return {
			ok: false,
			message: `打不开 ${appPath}：${error instanceof Error ? error.message : String(error)}`,
			appPath,
		};
	}

	// 等它 bind 出 socket：起进程到 listen 之间通常几十毫秒，给 5 秒余量
	const sock = socketPath();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (existsSync(sock)) {
			log?.warn("helper 已启动", { appPath });
			return { ok: true, message: `已启动：${appPath}`, appPath };
		}
	}
	return {
		ok: false,
		message: "已经尝试打开 Agent Computer，但 5 秒内没等到它连上来（首次打开可能要点一下系统授权）",
		appPath,
	};
}
