/**
 * 启动自检（ADR-0007 §启动自检）。
 *
 * 「能不能跑起来」必须在启动那一刻说清楚，而不是等用户往里打字时才炸。
 * 三项检查：数据目录可写 · 工作区根合法（在 util/env.ts）· 端口可用（在 index.ts）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** 数据目录可写：建目录 + 写一个探针文件再删掉（比只看权限位可靠） */
export async function checkDataDirWritable(dataDir: string): Promise<CheckResult> {
	try {
		await mkdir(dataDir, { recursive: true });
		const probe = join(dataDir, ".write-probe");
		await writeFile(probe, "ok", "utf8");
		await rm(probe, { force: true });
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			reason: `数据目录不可写：${dataDir}（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
}

export type PortError = { code?: string };

/** 把 listen 的错误翻译成人话（尤其是「端口被占」这种最常见的一种） */
export function describeListenError(error: PortError, port: number, holderHint?: string): string {
	if (error.code === "EADDRINUSE") {
		const hint = holderHint ? `；${holderHint}` : "；先确认是否已有实例在跑（看数据目录里的 server.lock）";
		return `端口 ${port} 已被占用，本进程退出${hint}`;
	}
	if (error.code === "EACCES") return `没有权限监听端口 ${port}（小于 1024 的端口通常需要特权）`;
	return `监听端口 ${port} 失败：${error.code ?? "未知错误"}`;
}
