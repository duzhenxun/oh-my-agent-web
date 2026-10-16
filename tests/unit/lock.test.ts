/**
 * 单实例锁（ADR-0007 守卫 1）：三态 + 不删别人的锁。
 * 用真实临时目录 + 注入的存活判断（不真的去杀进程）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireLock,
	describeHolder,
	lockPath,
	parseLock,
	readLock,
	releaseLock,
	writeLock,
} from "../../server/session/lock.js";

let dataDir = "";

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "agent-web-lock-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

const alive = { isAlive: () => true };
const dead = { isAlive: () => false };

describe("parseLock", () => {
	it("解析合法锁；坏 JSON / 缺字段返回 null", () => {
		expect(parseLock('{"pid":1,"port":8790,"startedAt":5}')).toEqual({ pid: 1, port: 8790, startedAt: 5 });
		expect(parseLock("{ 坏")).toBeNull();
		expect(parseLock('{"port":8790}')).toBeNull();
		expect(parseLock('{"pid":1,"port":8790}')).toEqual({ pid: 1, port: 8790, startedAt: 0 });
	});
});

describe("三态（ADR-0007）", () => {
	it("无锁 → 建锁并启动（不算接管）", async () => {
		const result = await acquireLock(dataDir, { pid: 111, port: 8790, startedAt: 1 }, alive);
		expect(result).toEqual({ ok: true, stale: false, previous: null });
		expect(await readLock(dataDir)).toEqual({ pid: 111, port: 8790, startedAt: 1 });
	});

	it("有锁且 pid 存活 → 拒绝启动，并把对方是谁带回来", async () => {
		await writeLock(dataDir, { pid: 111, port: 8790, startedAt: 1 });
		const result = await acquireLock(dataDir, { pid: 222, port: 8790, startedAt: 2 }, alive);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.holder).toEqual({ pid: 111, port: 8790, startedAt: 1 });
		// 拒绝时不能覆盖对方的锁
		expect(await readLock(dataDir)).toEqual({ pid: 111, port: 8790, startedAt: 1 });
	});

	it("有锁但 pid 已死 → 陈旧锁，自动接管", async () => {
		await writeLock(dataDir, { pid: 111, port: 8790, startedAt: 1 });
		const result = await acquireLock(dataDir, { pid: 222, port: 8790, startedAt: 2 }, dead);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.stale).toBe(true);
			expect(result.previous?.pid).toBe(111);
		}
		expect(await readLock(dataDir)).toEqual({ pid: 222, port: 8790, startedAt: 2 });
	});

	it("同一个 pid 重复抢锁视为自己（重启后重新拿）", async () => {
		await writeLock(dataDir, { pid: 111, port: 8790, startedAt: 1 });
		const result = await acquireLock(dataDir, { pid: 111, port: 8790, startedAt: 9 }, alive);
		expect(result.ok).toBe(true);
		expect(await readLock(dataDir)).toEqual({ pid: 111, port: 8790, startedAt: 9 });
	});

	it("锁文件内容坏掉时按「无锁」处理（不把自己锁死）", async () => {
		writeFileSync(lockPath(dataDir), "{ 坏锁", "utf8");
		const result = await acquireLock(dataDir, { pid: 111, port: 8790, startedAt: 1 }, alive);
		expect(result.ok).toBe(true);
	});
});

describe("释放", () => {
	it("只有锁还属于自己时才删", async () => {
		await writeLock(dataDir, { pid: 111, port: 8790, startedAt: 1 });
		await releaseLock(dataDir, 999); // 别人的锁
		expect(existsSync(lockPath(dataDir))).toBe(true);

		await releaseLock(dataDir, 111);
		expect(existsSync(lockPath(dataDir))).toBe(false);
	});

	it("锁不存在时释放不报错", async () => {
		await releaseLock(dataDir, 111);
		expect(await readLock(dataDir)).toBeNull();
	});
});

describe("给人类看的描述", () => {
	it("带 pid / 端口 / 启动时间", () => {
		const text = describeHolder({ pid: 4321, port: 8790, startedAt: Date.now() });
		expect(text).toContain("4321");
		expect(text).toContain("8790");
	});
});
