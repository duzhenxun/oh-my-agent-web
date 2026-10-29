/**
 * 安装后瘦身：只保留**当前平台**的 node-pty 预编译产物。
 *
 * 为什么值得做：node-pty 包里为四个平台各带了一份预编译二进制，其中 Windows 那两份
 * 就要 58MB —— 在 macOS / Linux 上它们永远用不到，却会躺在每一次生产安装里
 * （生产依赖 216MB 里它一个人占 62MB）。
 *
 * 安全性：node-pty 运行时只按 `<platform>-<arch>` 目录找自己的预编译产物
 * （见 node-pty/lib/...），删掉别人的不影响本机；`npm ci` 会原样装回来。
 * 没有预编译产物的平台（例如 Linux）本来就要现场编译，这里删光也不会影响编译。
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { chmodSync } from "node:fs";
import { join } from "node:path";

const PREBUILDS = join("node_modules", "node-pty", "prebuilds");
const keep = `${process.platform}-${process.arch}`;

if (existsSync(PREBUILDS)) {
	let removed = 0;
	for (const entry of readdirSync(PREBUILDS)) {
		if (entry === keep) continue;
		try {
			rmSync(join(PREBUILDS, entry), { recursive: true, force: true });
			removed += 1;
		} catch {
			// 只读文件系统 / 权限不足：留着就是，不该让 npm install 失败
		}
	}

	// spawn-helper 必须有可执行位（npm 打 tarball 时可能丢掉）
	const current = join(PREBUILDS, keep, "spawn-helper");
	if (existsSync(current) && statSync(current).isFile()) {
		try {
			chmodSync(current, 0o755);
		} catch {
			// Windows 上没有可执行位的概念，忽略
		}
	}

	if (removed > 0) console.log(`[oh-my-agent-web] node-pty 已裁掉 ${removed} 个无关平台的预编译产物（保留 ${keep}）`);
}
