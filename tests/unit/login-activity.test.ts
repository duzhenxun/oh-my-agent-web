/**
 * 登录活动记录（`server/http/login-activity.ts`）：设置 → 远程 里那一列「谁从哪个 IP 试过」。
 *
 * 用户 2026-11-02：「远程里可以显示哪个 ip 登陆过、登错几次、登陆成功等信息，按时间最新的在最前面」。
 *
 * 要钉住的是三件事：
 *   ① 顺序是**最新在最前**（界面直接照着画，不再自己排）；
 *   ② 有上限（爆破时不能让文件无限长大），保下来的应该是**最近的**那些；
 *   ③ 落盘后重启还在 —— 「昨晚谁在试我的密码」这种事，重启一次就忘掉等于没有。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLoginActivity } from "../../server/http/login-activity.ts";

function tempFile(): { file: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "aw-login-activity-"));
	return { file: join(dir, "login-activity.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("登录活动记录", () => {
	it("最新的在最前面", () => {
		const activity = createLoginActivity();
		activity.record({ address: "10.0.0.1", kind: "failure", attempts: 1, at: 1000 });
		activity.record({ address: "10.0.0.1", kind: "failure", attempts: 2, at: 2000 });
		activity.record({ address: "10.0.0.1", kind: "locked", attempts: 3, lockMinutes: 30, at: 3000 });
		activity.record({ address: "10.0.0.1", kind: "success", at: 4000 });

		const list = activity.list();
		assert.deepEqual(
			list.map((entry) => entry.kind),
			["success", "locked", "failure", "failure"],
		);
		assert.equal(list[0]?.at, 4000);
	});

	it("带上「连续第几次」「暂停多少分钟」这些细节", () => {
		const activity = createLoginActivity();
		activity.record({ address: "8.8.8.8", kind: "failure", attempts: 2, at: 10 });
		activity.record({ address: "8.8.8.8", kind: "locked", attempts: 3, lockMinutes: 30, at: 20 });
		const [locked, failure] = activity.list();
		assert.equal(failure?.attempts, 2);
		assert.equal(failure?.lockMinutes, undefined);
		assert.equal(locked?.attempts, 3);
		assert.equal(locked?.lockMinutes, 30);
	});

	it("超过上限时保留下最近的（不是最早的）", () => {
		const activity = createLoginActivity({ limit: 3 });
		for (let index = 1; index <= 5; index += 1) {
			activity.record({ address: "1.1.1.1", kind: "failure", attempts: index, at: index * 100 });
		}
		assert.deepEqual(
			activity.list().map((entry) => entry.at),
			[500, 400, 300],
		);
	});

	it("落盘后重启还在，且读回来也按时间倒序", () => {
		const { file, cleanup } = tempFile();
		try {
			const first = createLoginActivity({ file });
			first.record({ address: "6.6.6.6", kind: "failure", attempts: 1, at: 1000 });
			first.record({ address: "6.6.6.6", kind: "locked", attempts: 3, lockMinutes: 30, at: 3000 });
			first.record({ address: "7.7.7.7", kind: "success", at: 2000 });

			const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown[] };
			assert.equal(raw.entries?.length, 3);

			const second = createLoginActivity({ file });
			assert.deepEqual(
				second.list().map((entry) => entry.at),
				[3000, 2000, 1000],
				"就算文件里顺序乱，读回来也要是最新在前",
			);
		} finally {
			cleanup();
		}
	});

	it("坏文件当空表处理，不抛错（也不把文件重写成干净的）", () => {
		const { file, cleanup } = tempFile();
		try {
			// 先写一条合法记录拿到目录，再把它砸坏
			createLoginActivity({ file }).record({ address: "1.2.3.4", kind: "success", at: 1 });
			writeFileSync(file, "{ not json", "utf8");
			const activity = createLoginActivity({ file });
			assert.deepEqual(activity.list(), []);
			// 还能继续记（下一次记录时自然覆盖掉坏文件）
			activity.record({ address: "1.2.3.4", kind: "success", at: 5 });
			assert.equal(activity.list().length, 1);
		} finally {
			cleanup();
		}
	});
});
