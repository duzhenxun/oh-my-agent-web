/**
 * 把文件权限收紧成「只有我能读写」（凭证类文件专用）。
 *
 * POSIX 上就是 `chmod 0600`。**Windows 上 `chmod` 是空操作**（权限走 ACL），
 * 所以「凭证只有我能读」这个前提在 Windows 上根本不成立 —— 实际用的是从父目录
 * 继承下来的 ACL，同机其它账户可能读得到。要真的收紧就得改 ACL。
 *
 * 这里刻意做成 best effort：收紧权限失败不该让「保存设置」整个失败
 * （用户看得见的是设置存不下来，而不是 ACL 没收紧）。
 */
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";

export async function chmodSecret(path: string): Promise<void> {
	if (process.platform !== "win32") {
		await chmod(path, 0o600);
		return;
	}
	await restrictAclToCurrentUser(path);
}

/**
 * 「**任何账户都能读**」的权限（`rw-r--r--`）：给访问密码、VAPID 密钥这类
 * 需要被同机其它进程 / 账户读到的东西用（用户 2026-10-30 明确要求）。
 *
 * 代价说清楚：同机任何账户都能读到明文密码与私钥。默认仍然是 0600（`chmodSecret`），
 * 只有明确选择共享的那几个文件走这里。
 */
export const SHARED_FILE_MODE = 0o644;

export async function chmodShared(path: string): Promise<void> {
	if (process.platform !== "win32") await chmod(path, SHARED_FILE_MODE);
	// Windows 上是继承来的 ACL：放宽就是「什么都不用做」，加密钥类文件不做 icacls 收紧
}

/**
 * `icacls <文件> /inheritance:r /grant:r <用户>:F`
 *   /inheritance:r —— 去掉从父目录继承来的 ACE（这一条才是关键）
 *   /grant:r       —— 覆盖式授予当前用户完全控制
 */
function restrictAclToCurrentUser(path: string): Promise<void> {
	const user = process.env.USERNAME ?? process.env.USER ?? "";
	if (user === "") return Promise.resolve();
	return new Promise((done) => {
		let child;
		try {
			child = spawn("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			done();
			return;
		}
		child.on("error", () => done());
		child.on("exit", () => done());
	});
}
