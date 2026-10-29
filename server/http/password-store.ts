/**
 * 运行时可改的访问密码（落盘在 `<dataDir>/password`）。
 *
 * 为什么要可变：服务第一次被远程访问时可能还没设过密码 —— 这时页面直接给出「设置访问密码」
 * 的表单（见 `auth-routes.ts` 的 `POST /api/auth/setup`），设完立刻能用，不必回终端重启。
 *
 * 落盘格式与 `cli-config.ts` 读的那份一致（一行明文，0600）：下次启动由它读出来，
 * 命令行/环境变量仍然优先级最高。
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chmodSecret } from "../util/file-mode.js";

export type PasswordStore = {
	get(): string | null;
	set(password: string): Promise<void>;
};

/**
 * 内存里只留一份当前值（`get()` 是高频路径：每个请求都要过），写盘走「临时文件 + rename」，
 * 避免写到一半被读到半截密码。
 */
export function createPasswordStore(initial: string | null, file: string): PasswordStore {
	let current = initial;
	return {
		get: () => current,
		set: async (password) => {
			await mkdir(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, `${password}\n`, { encoding: "utf8", mode: 0o600 });
			// Windows 上 chmod 是空操作，走 icacls（见 file-mode.ts）
			await chmodSecret(tmp);
			await rename(tmp, file);
			current = password;
		},
	};
}
