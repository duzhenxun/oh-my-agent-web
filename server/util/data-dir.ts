/**
 * 数据目录的**一次性搬家**：`~/.agent-web` → `~/.oh-my-agent-web`。
 *
 * 为什么要在启动时做、而不是让用户手动 mv：
 *   那个目录里放的全是「丢了就麻烦」的东西 —— 远程访问密码、允许的域名、审批规则、
 *   推送订阅、客户端设置、会话索引与日志。改个名字就让远程访问变 403 / 推送失效，
 *   属于「程序自己惹的祸」。
 *
 * 三条边界：
 *   1. 只在**用的是默认目录**时搬（用户显式 `--data-dir` 就绝不动别人的文件）；
 *   2. 只在**新目录还不存在**时搬（已经搬过 / 新目录已有数据就什么都不做）；
 *   3. 整个目录 rename（同一分区，原子），失败就打印一句该怎么办，不阻断启动。
 */
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from "./env.js";

export function migrateLegacyDataDir(options: {
	/** 这次启动准备用的数据目录（绝对路径） */
	dataDir: string;
	/** 打日志用（cli 里是 console.log，服务里是 logger.info） */
	log: (line: string) => void;
	home?: string;
}): boolean {
	const home = options.home ?? homedir();
	const target = resolve(options.dataDir);
	if (target !== resolve(join(home, DEFAULT_DATA_DIR_NAME))) return false; // 自定义目录：不碰
	const legacy = join(home, LEGACY_DATA_DIR_NAME);
	if (!existsSync(legacy) || existsSync(target)) return false;
	try {
		renameSync(legacy, target);
		options.log(`已把数据目录从 ${legacy} 迁移到 ${target}（密码 / 推送订阅 / 设置 / 会话索引都在里面）`);
		return true;
	} catch (error) {
		options.log(
			`旧数据目录 ${legacy} 迁移失败：${error instanceof Error ? error.message : String(error)}` +
				`\n  → 手动搬一次即可：mv ${legacy} ${target}`,
		);
		return false;
	}
}
