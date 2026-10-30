/**
 * 运行时可改的访问密码（落盘在 `<dataDir>/password`）。
 *
 * 为什么要可变：服务第一次被远程访问时可能还没设过密码 —— 这时页面直接给出「设置访问密码」
 * 的表单（见 `auth-routes.ts` 的 `POST /api/auth/setup`），设完立刻能用，不必回终端重启。
 *
 * 落盘格式与 `cli-config.ts` 读的那份一致（一行明文，**0644：同机任何账户可读**，
 * 用户 2026-10-30 要求）：下次启动由它读出来，
 * 命令行/环境变量仍然优先级最高。
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SHARED_FILE_MODE, chmodShared } from "../util/file-mode.js";

export type PasswordStore = {
	get(): string | null;
	set(password: string): Promise<void>;
};

/**
 * 把密码写进 `<dataDir>/password`（一行明文，0600）。
 *
 * `cli.ts` 也要用它：启动时 `-P` 给的密码要顺手存下来，
 * 这样下次不带参数重启、或者远程访问设置页改密码，读到的都是同一份。
 */
export async function writePasswordFile(file: string, password: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${password}\n`, { encoding: "utf8", mode: SHARED_FILE_MODE });
	await chmodShared(tmp);
	await rename(tmp, file);
}

/**
 * 这次启动到底用哪个密码：**唯一来源是 `<dataDir>/password`**。
 *
 * 为什么不再认 `AGENT_WEB_PASSWORD`（用户 2026-10-30：「都用 ~/.oh-my-agent-web/password
 * 这下面的密码，不需要走 AGENT_WEB_PASSWORD」）：
 *   两处都能定密码时，“改了却好像没改”就注定会发生 —— 在「设置 → 远程」里改的是文件，
 *   而环境变量优先就等于改动被静默盖掉（真实事故：重启后远程登录“密码变了”）。
 *
 * 所以：
 *   - 文件有值 → 就用它（环境变量只能被覆盖，不能篡改）；
 *   - 文件没有、但环境变量/`-P` 给了 → **一次性落盘**，以后都读文件（老部署不用改习惯）；
 *   - 都没有 → 没有密码 = 远程一律不开（和以前一致）。
 *
 * 返回 `source` 只用于日志/提示，**绝不回显密码本身**。
 */
export function resolveStartupPassword(
	file: string,
	envPassword: string | undefined,
): { password: string | null; source: "file" | "migrated" | "none"; conflict: boolean } {
	const fromFile = readPasswordFileSync(file);
	const fromEnv = (envPassword ?? "").trim();
	if (fromFile !== null) {
		return { password: fromFile, source: "file", conflict: fromEnv !== "" && fromEnv !== fromFile };
	}
	if (fromEnv === "") return { password: null, source: "none", conflict: false };
	try {
		// 同步写：调用点在 `readConfig` 之前，那里还没法 await
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${fromEnv}\n`, { encoding: "utf8", mode: SHARED_FILE_MODE });
		// 与 `chmodShared` 同口径地 best effort（Windows 上权限走 ACL，chmod 是空操作）
		if (process.platform !== "win32") chmodSync(file, SHARED_FILE_MODE);
		return { password: fromEnv, source: "migrated", conflict: false };
	} catch {
		// 存不下不该拦住启动：本次内存里仍然用它，下次再给一次
		return { password: fromEnv, source: "migrated", conflict: false };
	}
}

/** 读密码文件（只取第一行；不存在/读不了都是 null） */
function readPasswordFileSync(file: string): string | null {
	try {
		const first = (readFileSync(file, "utf8").split("\n")[0] ?? "").trim();
		return first === "" ? null : first;
	} catch {
		return null;
	}
}

/**
 * 内存里只留一份当前值（`get()` 是高频路径：每个请求都要过），写盘走「临时文件 + rename」，
 * 避免写到一半被读到半截密码。
 */
export function createPasswordStore(initial: string | null, file: string): PasswordStore {
	let current = initial;
	return {
		get: () => current,
		set: async (password) => {
			await writePasswordFile(file, password);
			current = password;
		},
	};
}
