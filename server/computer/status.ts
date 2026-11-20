/**
 * 电脑控制的状态：helper 是否安装、是否在运行、权限是否授予、Skill 是否启用。
 *
 * 探测只做 hello 握手（不触发任何操作，也不会弹授权框）。
 */
import { HelperClient, type HelloResult } from "./helper-client.js";
import { cliCommand, skillDir, skillEnabled } from "./skill.js";
import { findHelperApp, helperDownloadUrl, socketPath } from "./paths.js";

export type ComputerStatus = {
	/** 只支持 macOS；其它系统下整个功能不可用 */
	supported: boolean;
	helper: { installed: boolean; path: string | null };
	running: boolean;
	helperVersion: string | null;
	permissions: { accessibility: boolean; screenRecording: boolean } | null;
	/** 探测失败的原因（运行中时为 null） */
	error: string | null;
	/**
	 * 没安装时给前端的安装指引（已安装则为 null）。
	 * 不做自动安装：.app 不在 npm 包里，且没有开发者签名，首个打开必须用户右键确认。
	 */
	install: {
		downloadUrl: string;
		/** 没有开发者证书 → Gatekeeper 会拦，第一次要右键「打开」 */
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
	const client = new HelperClient({
		socketPath: socketPath(),
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

export async function getComputerStatus(): Promise<ComputerStatus> {
	const supported = process.platform === "darwin";
	const path = supported ? findHelperApp() : null;
	const probe = supported ? await probeHelper() : { running: false as const, error: "仅支持 macOS" };
	const hello = probe.running ? probe.hello : null;
	const installed = path !== null;
	return {
		supported,
		install: installed
			? null
			: {
					downloadUrl: helperDownloadUrl(),
					requiresRightClickOpen: true,
					steps: [
						"下载 Agent Computer.zip（就在项目仓库里），解压后把 Agent Computer.app 拖进「应用程序」",
						"在 Finder 里右键它 → 打开（还没做开发者签名，第一次会被系统拦一次）",
						"按提示到「系统设置 → 隐私与安全性」勾上「辅助功能」和「屏幕录制」",
					],
				},
		helper: { installed, path },
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
