/**
 * 「装一个本地识别程序」这件事的全部实现：给面板出安装提示、以及点一下之后真的把它装好。
 *
 * 三条纪律（和 helper/agent-computer 那套一致）：
 *   - **安装包放仓库 / 包里，用户点一下下载**：日常用户不该被要求装 Xcode 命令行工具
 *     去 `swiftc` 编译（那是开发机的事）；
 *   - **只装到 `Application Support` 下的固定位置**：TCC 授权绑 .app 的签名，装好后
 *     不随 npm 升级被替换，授权只问一次；包目录属于包管理器，不能当安装位；
 *   - **失败说得清楚，并给出兜底**：下载不通就告诉用户去点那个链接手动装，
 *     而不是甩一句 `fetch failed`。
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	asrDownloadUrl,
	asrSupportDir,
	bundledAppPath,
	bundledZipPath,
	installedAppPath,
	ASR_APP_NAME,
} from "./paths.js";

const run = promisify(execFile);

/** 下载 100~300KB 的 zip，给足余量；卡住不收就是事故 */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UNZIP_TIMEOUT_MS = 60_000;
/** .app 里的可执行文件（相对 .app 根） */
const APP_BINARY = "Contents/MacOS/asr-bridge";

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

/** 面板上「还没装」时给前端的提示（已装好就不需要了） */
export type AsrInstallHint = {
	downloadUrl: string;
	/** 装好之后 .app 的路径：自己下载了想手动放的人按这个路径放 */
	appPath: string;
	/** 服务端能不能替用户装（Linux / Windows 上根本没有这个程序，只能建议用 Chrome 识别） */
	canAutoInstall: boolean;
};

export function asrInstallHint(): AsrInstallHint {
	return {
		downloadUrl: asrDownloadUrl(),
		appPath: installedAppPath(),
		canAutoInstall: process.platform === "darwin",
	};
}

export type AsrInstallResult =
	| {
			ok: true;
			appPath: string;
			/** 从哪儿来的（日志/排错用） */
			via: "already" | "bundled-app" | "bundled-zip" | "download";
			message: string;
	  }
	| {
			ok: false;
			reason: "unsupported-platform" | "download" | "unpack" | "verify";
			message: string;
			/** 失败时也把链接给出去：用户自己点一下往往就通了 */
			downloadUrl: string;
	  };

class InstallError extends Error {
	constructor(
		readonly reason: "download" | "unpack" | "verify",
		message: string,
	) {
		super(message);
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch(() => false);
}

/** 一个 .app 是不是「装好了」：光有目录不算，可执行文件在才算 */
async function isUsableApp(app: string): Promise<boolean> {
	return exists(join(app, APP_BINARY));
}

/**
 * 下载 zip。
 *
 * 用 node 自带的 fetch（Node 22 有），不引第三方客户端：这里只要一次 GET + 落盘。
 * 明显不是 zip（比如公司网络返回了一个登录页）时直接当下载失败报，别拿去解压。
 */
async function download(url: string): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			headers: { "user-agent": "oh-my-agent-web" },
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InstallError("download", `下载本地识别程序失败（网络不通）：${message}`);
	}
	if (!response.ok) {
		throw new InstallError("download", `下载本地识别程序失败（HTTP ${response.status}）`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
		throw new InstallError("download", "下载到的不是一个 zip 包（可能被网络中间页拦了）");
	}
	return buffer;
}

/** 解压到临时目录，返回里面的 ASRBridge.app 路径 */
async function unpack(zipPath: string, workDir: string): Promise<string> {
	try {
		// ditto 而不是自己解 zip：可执行位、扩展属性、_CodeSignature 都要原样留着，
		// 否则签名失效 → 每次都要重新授权（见 paths.ts 的注释）
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, workDir], { timeout: UNZIP_TIMEOUT_MS });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InstallError("unpack", `解开安装包失败：${message}`);
	}
	const app = join(workDir, ASR_APP_NAME);
	if (!(await isUsableApp(app))) {
		throw new InstallError("unpack", "安装包里没有找到 ASRBridge.app（包可能损坏了）");
	}
	return app;
}

/**
 * 装好之前的最后几道检查：可执行位、隔离属性、签名。
 *
 * 隔离属性（com.apple.quarantine）正常不会出现（不是浏览器下载的），但真有就清掉 ——
 * 留着它，`open` 会弹「无法验证开发者」，用户就卡在那一步了。
 * 签名验不过只警告不失败：ad-hoc 签名本来就不被 Gatekeeper 认可，能跑就行。
 */
async function checkAndFix(app: string, log?: Logger): Promise<void> {
	const binary = join(app, APP_BINARY);
	await chmod(binary, 0o755);
	await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]).catch(() => undefined);
	await run("/usr/bin/codesign", ["--verify", "--strict", app]).catch((error: unknown) => {
		log?.warn("本地识别程序签名校验没通过（ad-hoc 签名不影响运行）", {
			message: error instanceof Error ? error.message : String(error),
		});
	});
}

/** 真正干活的那一半：装一份到 `Application Support`，返回结果（不抛异常） */
async function runInstall(log?: Logger): Promise<AsrInstallResult> {
	const downloadUrl = asrDownloadUrl();
	if (process.platform !== "darwin") {
		return {
			ok: false,
			reason: "unsupported-platform",
			message: "本地识别只有 macOS 版；这台机器请用「Chrome 原生」识别引擎（需要能连上 Google）",
			downloadUrl,
		};
	}

	const target = installedAppPath();
	if (await isUsableApp(target)) {
		return { ok: true, appPath: target, via: "already", message: "本地识别程序已经装好了" };
	}

	const workDir = await mkdtemp(join(tmpdir(), "oh-my-agent-web-asr-"));
	try {
		let staged: string;
		let via: "bundled-app" | "bundled-zip" | "download";

		const bundledApp = bundledAppPath();
		const bundledZip = bundledZipPath();
		if (bundledApp !== null) {
			// 开发机（跑过 ./helper/asr/build.sh）：直接拷那份，不用再下一遍
			const copied = join(workDir, ASR_APP_NAME);
			await run("/usr/bin/ditto", [bundledApp, copied], { timeout: UNZIP_TIMEOUT_MS });
			if (!(await isUsableApp(copied))) {
				throw new InstallError("unpack", "源码目录里那份 ASRBridge.app 不完整，请重新跑 ./helper/asr/build.sh");
			}
			staged = copied;
			via = "bundled-app";
		} else if (bundledZip !== null) {
			// 随 npm 包发的那份（离线/连不上 GitHub 时的后备）
			staged = await unpack(bundledZip, workDir);
			via = "bundled-zip";
		} else {
			const zipPath = join(workDir, "ASRBridge.zip");
			await writeFile(zipPath, await download(downloadUrl));
			staged = await unpack(zipPath, workDir);
			via = "download";
		}

		await checkAndFix(staged, log);

		await mkdir(asrSupportDir(), { recursive: true });
		// 旧的一份（半装、损坏）先清掉：ditto 合并进已有目录会留下过期文件
		await rm(target, { recursive: true, force: true });
		await run("/usr/bin/ditto", [staged, target], { timeout: UNZIP_TIMEOUT_MS });
		if (!(await isUsableApp(target))) {
			throw new InstallError("verify", `装完之后没找到可执行文件：${join(target, APP_BINARY)}`);
		}
		return {
			ok: true,
			appPath: target,
			via,
			message: "本地识别程序装好了（首次启动会弹一次系统授权）",
		};
	} catch (error) {
		const reason = error instanceof InstallError ? error.reason : "verify";
		const message = error instanceof Error ? error.message : String(error);
		log?.warn("安装本地识别程序失败", { reason, message });
		return { ok: false, reason, message, downloadUrl };
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * 同一时间只允许一次安装：前端连点两下、或者两个窗口同时点，
 * 不该并发写同一个目标目录（第二个会删掉第一个正在写的产物）。
 */
let inflight: Promise<AsrInstallResult> | null = null;

export function installAsrApp(log?: Logger): Promise<AsrInstallResult> {
	if (inflight !== null) return inflight;
	inflight = runInstall(log).finally(() => {
		inflight = null;
	});
	return inflight;
}
