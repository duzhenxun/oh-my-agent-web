/**
 * 电脑控制的状态：helper 是否安装、是否在运行、权限是否授予、Skill 是否启用。
 *
 * 探测只做 hello 握手（不触发任何操作，也不会弹授权框）。
 */
import { existsSync } from "node:fs";
import { HelperClient, type HelloResult } from "./helper-client.js";
import { cliCommand, skillDir, skillEnabled } from "./skill.js";
import {
	findHelperApp,
	helperBinaryPath,
	helperDownloadUrl,
	helperTransport,
	socketPath,
	type HelperTransport,
} from "./paths.js";

export type ComputerStatus = {
	/** 服务进程所在平台：前端据此决定「不可用」时给哪种文案（Windows 是「敬请期待」） */
	platform: NodeJS.Platform;
	/** 这个平台**将来会做**、但现在还没有（Windows）：面板显示「敬请期待」而不是报错 */
	comingSoon: boolean;
	/** macOS 且找得到内嵌二进制或旧版 helper（socket / .app）时可用 */
	supported: boolean;
	/** 实际走的传输；前端 / 日志据此判断是内嵌还是旧 .app */
	transport: HelperTransport;
	/** 内嵌二进制路径（找不到为 null） */
	binary: string | null;
	helper: { installed: boolean; path: string | null };
	running: boolean;
	helperVersion: string | null;
	permissions: { accessibility: boolean; screenRecording: boolean } | null;
	/** 探测失败的原因（运行中时为 null） */
	error: string | null;
	/**
	 * 没装时给前端的安装指引（装了就是 null）。
	 *
	 * 2026-11-24 恢复了这条路：电脑控制用**用户自己装的 Agent Computer.app**，
	 * 不内嵌进 oh-my-agent-web（那个方案用户否了 —— 两件东西的版本 / 签名 / 权限捆在一起不好管）。
	 * 不做自动安装：.app 不在 npm 包里，而且没有开发者签名，首次必须用户右键确认。
	 */
	install: {
		downloadUrl: string;
		/** 没开发者证书 → Gatekeeper 会拦，第一次要右键「打开」 */
		requiresRightClickOpen: boolean;
		/** 面板上按顺序展示的步骤 */
		steps: string[];
	} | null;
	skill: { enabled: boolean; dir: string; cli: string };
};

export const STATUS_CLIENT_NAME = "oh-my-agent-web";

export async function probeHelper(
	timeoutMs = 1500,
): Promise<{ running: true; hello: HelloResult } | { running: false; error: string }> {
	const binary = helperBinaryPath();
	const client = new HelperClient({
		socketPath: socketPath(),
		binaryPath: binary,
		transport: helperTransport(process.env, binary),
		clientName: STATUS_CLIENT_NAME,
		session: { sessionId: "status-probe", turnId: null },
	});
	try {
		const hello = await client.connect(timeoutMs);
		return { running: true, hello };
	} catch (error) {
		return { running: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		client.close();
	}
}

/**
 * 主动申请权限（2026-11-24 用户：「添授权时，自动添加到上面」）。
 *
 * macOS 的「辅助功能 / 屏幕录制」列表**不会**自动出现一个 App —— 只有当那个进程自己调过
 * `AXIsProcessTrustedWithOptions(prompt: true)` / `CGRequestScreenCaptureAccess()` 时，
 * 系统才会把它登记进列表并弹一次授权框。helper 里本来就有这个能力（`requestAccess`），
 * 但内嵌 stdio 方案把它漏掉了：面板只能让用户去列表里手动 `+` 找可执行文件，很别扭。
 *
 * 这里通过 helper 的 `requestAccess` 触发登记 + 系统弹框，返回触发前后的权限快照。
 * 注意：helper 是**新起的子进程**，登记的是它自己（TCC 归属问题见 TDD 里的说明）。
 */
export async function requestComputerAccess(
	timeoutMs = 1500,
): Promise<{ accessibility: boolean; screenRecording: boolean }> {
	const binary = helperBinaryPath();
	const client = new HelperClient({
		socketPath: socketPath(),
		binaryPath: binary,
		transport: helperTransport(process.env, binary),
		clientName: STATUS_CLIENT_NAME,
		session: { sessionId: "permission-request", turnId: null },
	});
	try {
		await client.connect(timeoutMs);
		const result = (await client.request("requestAccess", {})) as {
			accessibility?: boolean;
			screenRecording?: boolean;
		};
		return {
			accessibility: result?.accessibility === true,
			screenRecording: result?.screenRecording === true,
		};
	} finally {
		client.close();
	}
}

/**
 * 某个平台上「电脑控制」的可用形态 —— **纯函数**，单测据此锁住三种平台的分支，
 * 不用真的在 Windows 上跑一遍。
 *
 * - macOS：实现了（能不能用还要看 helper 二进制与权限，由 `getComputerStatus` 继续探）；
 * - Windows：**还没做**（2026-11-24 用户决定：先不做，界面显示「敬请期待」），
 *   所以这里给 `comingSoon`，让面板显示"还没上线"而不是"这台机器不支持"；
 * - 其它（Linux 等）：没有任何实现，也不承诺。
 */
export function computerControlMode(platform: NodeJS.Platform): {
	supported: boolean;
	comingSoon: boolean;
} {
	if (platform === "darwin") return { supported: true, comingSoon: false };
	if (platform === "win32") return { supported: false, comingSoon: true };
	return { supported: false, comingSoon: false };
}

export async function getComputerStatus(): Promise<ComputerStatus> {
	const platform = process.platform;
	const mode = computerControlMode(platform);
	const darwin = platform === "darwin";
	/**
	 * 只用**用户自己装的 Agent Computer.app**（2026-11-24 用户拍定：不搞内嵌 helper）。
	 * `helperBinaryPath()` 留着只为开发态 / `AGENT_COMPUTER_BINARY` 调试；打包后它必然是 null，
	 * 于是 `transport` 会落到 socket，走的还是那份 .app。
	 */
	const binary = mode.supported ? helperBinaryPath() : null;
	const appPath = darwin ? findHelperApp() : null;
	const transport = helperTransport(process.env, binary);
	const installed = binary !== null || appPath !== null;
	const supported = mode.supported && (installed || existsSync(socketPath()));
	const probe = supported
		? await probeHelper()
		: {
				running: false as const,
				error: mode.comingSoon
					? null // Windows 不是“出错”，是“还没做”：由前端按 comingSoon 显示「敬请期待」
					: darwin
						? "没找到 Agent Computer.app（也没连上它的 socket）"
						: "电脑控制目前只支持 macOS",
			};
	const hello = probe.running ? probe.hello : null;
	return {
		platform,
		comingSoon: mode.comingSoon,
		supported,
		transport,
		binary,
		/** 没装（且是 macOS）：给前端的安装指引；Windows / 其它平台不给 */
		install:
			darwin && !installed && !probe.running
				? {
						downloadUrl: helperDownloadUrl(),
						requiresRightClickOpen: true,
						steps: [
							"下载 Agent Computer.zip，解压后把 Agent Computer.app 拖进「应用程序」",
							"第一次双击会被系统拦下（没有开发者签名）：到「系统设置 → 隐私与安全性」，在下方点「仍要打开」再确认一次。新版 macOS 已经不再允许用「右键 → 打开」跳过这一步",
							"打开后按窗口提示勾上「辅助功能」和「屏幕录制」；要用语音输入，再给「麦克风」与「语音识别」",
						],
					}
				: null,
		helper: { installed, path: binary ?? appPath },
		running: probe.running,
		helperVersion: hello?.helperVersion ?? null,
		permissions: hello
			? {
					accessibility: hello.permissions?.accessibility === true,
					screenRecording: hello.permissions?.screenRecording === true,
				}
			: null,
		error: probe.running ? null : probe.error,
		skill: { enabled: skillEnabled(), dir: skillDir(), cli: cliCommand() },
	};
}
