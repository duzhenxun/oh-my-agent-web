/**
 * 瘦身：只保留**当前平台**的 node-pty 预编译产物。
 *
 * 为什么值得做：node-pty 包里为四个平台各带了一份预编译二进制，其中 Windows 那两份
 * 就要 58MB —— 在 macOS / Linux 上它们永远用不到，却会躺在每一次生产安装里
 * （生产依赖 216MB 里它一个人占 62MB）。
 *
 * 为什么**不**再放在 `postinstall`（ADR 变更点）：npm 11.16 起把「没被 `allowScripts`
 * 批准过的 install 脚本」逐条打出来，并提示用户 `npm approve-scripts <pkg>`：
 * 一条本来只是省体积的可选优化，变成了每个用户都要面对的一次安全审查 —— 大多数人
 * 不会去 approve，于是体积没省下来、还多一段红色告警。改成**第一次运行时顺手做**：
 * 幂等（裁完就只剩一个目录，再跑是空转）、几十微秒、失败也不影响启动。
 *
 * 安全性：node-pty 运行时只按 `<platform>-<arch>` 目录找自己的预编译产物
 * （见 node-pty/lib/prebuild-loader），删掉别人的不影响本机；`npm ci` 会原样装回来。
 * 没有预编译产物的平台（例如 Linux）本来就要现场编译，这里删光也不会影响编译。
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** node-pty 的 prebuilds 目录；没装（optionalDependencies，装不上很常见）时返回 null */
function defaultPrebuildsDir(): string | null {
	try {
		const pkg = createRequire(import.meta.url).resolve("node-pty/package.json");
		return join(dirname(pkg), "prebuilds");
	} catch {
		return null;
	}
}

export type PruneResult = {
	/** 保留的平台目录名（`<platform>-<arch>`） */
	keep: string;
	/** 这次删掉了几个别的平台目录 */
	removed: number;
	/** spawn-helper 是否补过可执行位 */
	fixedMode: boolean;
};

/**
 * 删掉非本平台的预编译产物，并给本平台的 `spawn-helper` 补可执行位
 * （npm 打 tarball 时可能丢掉可执行位）。
 *
 * @param prebuildsDir 仅供单测注入；默认从 node-pty 包位置推出来
 * @returns 没东西可做（node-pty 没装 / 已经裁干净）时返回 null
 */
export function prunePtyPrebuilds(prebuildsDir?: string): PruneResult | null {
	const dir = prebuildsDir ?? defaultPrebuildsDir();
	if (!dir || !existsSync(dir)) return null;

	const keep = `${process.platform}-${process.arch}`;
	let removed = 0;
	for (const entry of readdirSync(dir)) {
		if (entry === keep) continue;
		try {
			rmSync(join(dir, entry), { recursive: true, force: true });
			removed += 1;
		} catch {
			// 只读文件系统 / 权限不足（例如全局装到 /usr/lib 下）：留着就是，不该影响启动
		}
	}

	// spawn-helper 必须有可执行位，否则 posix_spawn 起来就是 EACCES
	let fixedMode = false;
	const helper = join(dir, keep, "spawn-helper");
	try {
		const stats = statSync(helper);
		// 只在真的缺可执行位时才动手：否则每次启动都会「修」一遍，白白多一条日志
		if (stats.isFile() && (stats.mode & 0o777) !== 0o755) {
			chmodSync(helper, 0o755);
			fixedMode = true;
		}
	} catch {
		// 没有 spawn-helper（Windows）/ 没有权限：都不该影响启动
	}

	if (removed === 0 && !fixedMode) return null;
	return { keep, removed, fixedMode };
}
