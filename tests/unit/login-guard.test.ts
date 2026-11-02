/**
 * 登录失败锁（`server/http/login-guard.ts`）：连续输错 N 次 → 暂停 M 分钟。
 *
 * 用户 2026-11-02 的要求：「远程访问增加超过 3 次密码错误需要暂停 30 分钟的功能，
 * 这个多少次暂停多久可以在 设置/远程 中设置，默认是 3 次 30 分钟」。
 *
 * 这里把三件最容易写错的事钉住：
 *   ① **第 N 次就锁**（不是第 N+1 次），锁住期间不再比对密码；
 *   ② 锁**落盘**（重启后还在），但失败计数只在内存（重启归零可以接受）；
 *   ③ 策略校验不许把 0 次 / 0 分钟这类「一错就永久锁」的输入存进去。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_LOGIN_GUARD,
	createLoginGuard,
	describeLockout,
	normalizeLoginGuardPolicy,
} from "../../server/http/login-guard.ts";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

/** 可控时钟：所有用例都靠拨表推进，不真等 */
function bench(file?: string) {
	let now = START;
	const guard = createLoginGuard({ now: () => now, ...(file ? { file } : {}) });
	return {
		guard,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

function tempFile(): { file: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "aw-login-guard-"));
	return { file: join(dir, "login-guard.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("登录失败锁", () => {
	it("默认是 3 次 / 30 分钟", () => {
		const { guard } = bench();
		assert.deepEqual(guard.policy(), { maxFailures: 3, lockMinutes: 30 });
		assert.deepEqual(DEFAULT_LOGIN_GUARD, { maxFailures: 3, lockMinutes: 30 });
	});

	it("错 2 次还不锁，第 3 次当场锁住 30 分钟", () => {
		const { guard } = bench();
		const first = guard.noteFailure("1.2.3.4");
		assert.equal(first.locked, false);
		assert.equal(first.remainingAttempts, 2);
		const second = guard.noteFailure("1.2.3.4");
		assert.equal(second.locked, false);
		assert.equal(second.remainingAttempts, 1);

		const third = guard.noteFailure("1.2.3.4");
		assert.equal(third.locked, true, "第 3 次输错就该锁（不是第 4 次）");
		assert.equal(third.retryAfterSeconds, 30 * 60);
		assert.equal(third.remainingAttempts, 0);
	});

	it("锁住期间再问多少次都还是锁着的（不再消耗/重置）", () => {
		const { guard, advance } = bench();
		for (let i = 0; i < 3; i += 1) guard.noteFailure("1.2.3.4");
		advance(10 * MINUTE);
		const status = guard.status("1.2.3.4");
		assert.equal(status.locked, true);
		assert.equal(status.retryAfterSeconds, 20 * 60, "剩余时间要随时钟缩短");
		// 锁住期间的错误不再累加，也不会延长/缩短现有锁
		guard.noteFailure("1.2.3.4");
		assert.equal(guard.status("1.2.3.4").retryAfterSeconds, 20 * 60);
	});

	it("到点自动解锁，计数从 0 重新开始", () => {
		const { guard, advance } = bench();
		for (let i = 0; i < 3; i += 1) guard.noteFailure("1.2.3.4");
		advance(30 * MINUTE);
		const status = guard.status("1.2.3.4");
		assert.equal(status.locked, false);
		assert.equal(status.remainingAttempts, 3, "解锁后要重新给满次数");
		assert.equal(guard.noteFailure("1.2.3.4").locked, false);
	});

	it("登录成功会清掉这个来源的计数", () => {
		const { guard } = bench();
		guard.noteFailure("1.2.3.4");
		guard.noteFailure("1.2.3.4");
		guard.clear("1.2.3.4");
		assert.equal(guard.status("1.2.3.4").remainingAttempts, 3);
		assert.equal(guard.noteFailure("1.2.3.4").locked, false);
	});

	it("按来源分开：锁了一个来源不牵连别的", () => {
		const { guard } = bench();
		for (let i = 0; i < 3; i += 1) guard.noteFailure("6.6.6.6");
		assert.equal(guard.status("6.6.6.6").locked, true);
		assert.equal(guard.status("8.8.8.8").locked, false);
		assert.equal(guard.noteFailure("8.8.8.8").remainingAttempts, 2);
	});

	it("改密码这种全局动作能把所有来源一起放开", () => {
		const { guard } = bench();
		for (let i = 0; i < 3; i += 1) guard.noteFailure("6.6.6.6");
		guard.clearAll();
		assert.equal(guard.status("6.6.6.6").locked, false);
	});
});

describe("登录保护策略", () => {
	it("可以改次数与时长，改完立即生效", () => {
		const { guard } = bench();
		const saved = guard.setPolicy({ maxFailures: 5, lockMinutes: 10 });
		assert.equal(saved.ok, true);
		assert.deepEqual(guard.policy(), { maxFailures: 5, lockMinutes: 10 });
		for (let i = 0; i < 4; i += 1) assert.equal(guard.noteFailure("1.1.1.1").locked, false);
		const fifth = guard.noteFailure("1.1.1.1");
		assert.equal(fifth.locked, true);
		assert.equal(fifth.retryAfterSeconds, 10 * 60);
	});

	it("0 次 / 超范围 / 非数字一律报错，不静默改成默认值", () => {
		const { guard } = bench();
		for (const bad of [0, 21, -3, Number.NaN]) {
			const result = guard.setPolicy({ maxFailures: bad });
			assert.equal(result.ok, false, `maxFailures=${String(bad)} 应该被拒`);
		}
		for (const bad of [0, 1441, -1]) {
			const result = guard.setPolicy({ lockMinutes: bad });
			assert.equal(result.ok, false, `lockMinutes=${String(bad)} 应该被拒绝`);
		}
		assert.deepEqual(guard.policy(), DEFAULT_LOGIN_GUARD, "被拒的输入不该改到当前策略");
	});

	it("改策略会把数到一半的计数清掉（避免改严之后还带着旧次数）", () => {
		const { guard } = bench();
		guard.noteFailure("1.1.1.1");
		guard.noteFailure("1.1.1.1");
		guard.setPolicy({ maxFailures: 3, lockMinutes: 30 });
		assert.equal(guard.status("1.1.1.1").remainingAttempts, 3);
	});
});

describe("落盘", () => {
	it("锁与策略都能活过重启（读回同一个文件）", () => {
		const { file, cleanup } = tempFile();
		try {
			const first = bench(file);
			first.guard.setPolicy({ maxFailures: 4, lockMinutes: 15 });
			for (let i = 0; i < 4; i += 1) first.guard.noteFailure("9.9.9.9");

			const raw = JSON.parse(readFileSync(file, "utf8")) as {
				maxFailures?: number;
				lockMinutes?: number;
				locks?: unknown[];
			};
			assert.equal(raw.maxFailures, 4);
			assert.equal(raw.lockMinutes, 15);
			assert.equal(raw.locks?.length, 1, "锁要写进文件");

			// 新进程（同一个时钟）：策略和锁都还在 —— 否则「搞崩进程一次就解锁」
			const second = createLoginGuard({ file, now: () => START });
			assert.deepEqual(second.policy(), { maxFailures: 4, lockMinutes: 15 });
			assert.equal(second.status("9.9.9.9").locked, true);
			assert.equal(second.status("9.9.9.9").retryAfterSeconds, 15 * 60);
		} finally {
			cleanup();
		}
	});

	it("文件里的过期锁读回来就丢掉（不会拿一份陈年锁把人挡在外面）", () => {
		const { file, cleanup } = tempFile();
		try {
			const first = bench(file);
			for (let i = 0; i < 3; i += 1) first.guard.noteFailure("5.5.5.5");
			const later = createLoginGuard({ file, now: () => START + 31 * MINUTE });
			assert.equal(later.status("5.5.5.5").locked, false);
		} finally {
			cleanup();
		}
	});
});

describe("给用户看的文案", () => {
	it("分钟与小时都说得明白", () => {
		assert.match(
			describeLockout({ locked: true, retryAfterSeconds: 30 * 60, failures: 3, remainingAttempts: 0 }),
			/30 分钟/,
		);
		assert.match(
			describeLockout({ locked: true, retryAfterSeconds: 90 * 60, failures: 3, remainingAttempts: 0 }),
			/2 小时/,
		);
	});
});

describe("normalizeLoginGuardPolicy（读坏文件时的兜底）", () => {
	it("缺字段 / 类型不对就回落默认值，不抛错", () => {
		assert.deepEqual(normalizeLoginGuardPolicy(null), DEFAULT_LOGIN_GUARD);
		assert.deepEqual(normalizeLoginGuardPolicy({ maxFailures: "3" }), DEFAULT_LOGIN_GUARD);
		assert.deepEqual(normalizeLoginGuardPolicy({ maxFailures: 99, lockMinutes: 5 }), {
			maxFailures: 3,
			lockMinutes: 5,
		});
		assert.deepEqual(normalizeLoginGuardPolicy({ maxFailures: 7, lockMinutes: 60 }), {
			maxFailures: 7,
			lockMinutes: 60,
		});
	});
});
