/**
 * 单实例锁：`<dataDir>/server.lock`（ADR-0007）。
 *
 * 为什么是数据完整性的一部分：ADR-0005 的「只有一个写入者」是整套持久化推理的前提。
 * 两个进程同时追加同一批 jsonl = 转录损坏。所以「终端 A 忘关、又开终端 B」这件事
 * 必须在启动时被拦住，而不是等数据坏了才发现。
 *
 * 三态（ADR-0007 守卫 1）：
 *   - 无锁            → 建锁，启动；
 *   - 有锁且 pid 存活 → 拒绝启动，并把对方是谁告诉用户；
 *   - 有锁但 pid 已死 → **陈旧锁，自动接管**（否则崩一次之后服务就永远起不来了）。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LOCK_FILE = "server.lock";

export type LockInfo = { pid: number; port: number; startedAt: number };

export function lockPath(dataDir: string): string {
	return join(dataDir, LOCK_FILE);
}

export function parseLock(text: string): LockInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = parsed as Record<string, unknown>;
	if (typeof candidate.pid !== "number" || typeof candidate.port !== "number") return null;
	return {
		pid: candidate.pid,
		port: candidate.port,
		startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : 0,
	};
}

/** 默认的存活判断：`process.kill(pid, 0)` 不抛就是活着（EPERM 也算活着，只是不归我们管） */
export function defaultIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function readLock(dataDir: string): Promise<LockInfo | null> {
	try {
		return parseLock(await readFile(lockPath(dataDir), "utf8"));
	} catch {
		return null;
	}
}

export async function writeLock(dataDir: string, info: LockInfo): Promise<void> {
	const target = lockPath(dataDir);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(info)}\n`, "utf8");
}

export type AcquireResult = { ok: true; stale: boolean; previous: LockInfo | null } | { ok: false; holder: LockInfo };

export async function acquireLock(
	dataDir: string,
	info: LockInfo,
	deps: { isAlive: (pid: number) => boolean } = { isAlive: defaultIsAlive },
): Promise<AcquireResult> {
	const existing = await readLock(dataDir);
	if (existing && existing.pid !== info.pid && deps.isAlive(existing.pid)) {
		return { ok: false, holder: existing };
	}
	const stale = existing !== null;
	await writeLock(dataDir, info);
	return { ok: true, stale, previous: existing };
}

/** 释放锁：只有锁还属于自己时才删（避免把接管者的锁删掉） */
export async function releaseLock(dataDir: string, pid: number): Promise<void> {
	const existing = await readLock(dataDir);
	if (!existing || existing.pid !== pid) return;
	await rm(lockPath(dataDir), { force: true });
}

export function describeHolder(holder: LockInfo): string {
	const started = holder.startedAt > 0 ? new Date(holder.startedAt).toLocaleString() : "未知时间";
	return `pid ${holder.pid} · 端口 ${holder.port} · 启动于 ${started}`;
}
