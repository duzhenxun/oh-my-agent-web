/**
 * VAPID 的 subject 与「来源 / 锁定」判断（`server/push/vapid-config.ts` + `push.ts` 的 config 方法）。
 *
 * 这几条都是**真的把人坑过的**：
 *   1. `mailto:noreply@localhost` 看着正常，Apple 直接 403 `BadJwtToken`（Chrome 却没事）；
 *   2. 改了 subject 不该影响任何已订阅设备（只有换密钥才会）；
 *   3. 密钥来自环境变量时，界面上的「重新生成」不能清掉订阅再「假装换了」。
 *
 * 不碰网络：只看落盘的文件与返回值（真发推送不在这份测试里）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPushStore } from "../../server/push/push.ts";
import {
	FALLBACK_VAPID_SUBJECT,
	loadVapidKeys,
	loadVapidSubject,
	normalizeVapidSubject,
	saveVapidSubject,
	vapidSubjectProblem,
} from "../../server/push/vapid-config.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "omaw-vapid-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 环境变量优先级最高：测试里必须清干净，否则本机设过的 `VAPID_*` 会把结果带偏 */
async function withoutEnv(run: () => Promise<void>): Promise<void> {
	const saved = {
		VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
		VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
		VAPID_SUBJECT: process.env.VAPID_SUBJECT,
	};
	for (const name of Object.keys(saved)) delete process.env[name];
	try {
		await run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value !== undefined) process.env[name] = value;
		}
	}
}

test("normalizeVapidSubject：邮箱自动补 mailto，完整 URI 原样保留", () => {
	assert.equal(normalizeVapidSubject(" me@example.com "), "mailto:me@example.com");
	assert.equal(normalizeVapidSubject("mailto:me@example.com"), "mailto:me@example.com");
	assert.equal(normalizeVapidSubject("https://example.com/push"), "https://example.com/push");
	assert.equal(normalizeVapidSubject(""), "");
});

test("vapidSubjectProblem：localhost / http 都要被挡在保存这一步", () => {
	// 兜底值本身就是「不合法」——它就该在界面上标红，而不是被当成配好了
	assert.equal(vapidSubjectProblem(FALLBACK_VAPID_SUBJECT), "push.subject.host");
	assert.equal(vapidSubjectProblem("mailto:me@localhost"), "push.subject.host");
	assert.equal(vapidSubjectProblem("mailto:me@192.168.1.2"), "push.subject.host");
	assert.equal(vapidSubjectProblem("mailto:me@example.com"), null);
	assert.equal(vapidSubjectProblem("https://example.com"), null);
	assert.equal(vapidSubjectProblem("https://agent.example.com/push"), null);
	// web-push 只认 https：http 站点当 subject 会被它自己拒
	assert.equal(vapidSubjectProblem("http://example.com"), "push.subject.scheme");
	assert.equal(vapidSubjectProblem("ftp://example.com"), "push.subject.scheme");
	assert.equal(vapidSubjectProblem(""), "push.subject.empty");
});

test("subject 存盘 / 读回 / 清空回兜底", async () => {
	await withoutEnv(async () => {
		await withDir(async (dir) => {
			assert.deepEqual(await loadVapidSubject(dir), { subject: FALLBACK_VAPID_SUBJECT, source: "fallback" });

			await saveVapidSubject(dir, "me@example.com");
			assert.deepEqual(await loadVapidSubject(dir), { subject: "mailto:me@example.com", source: "file" });
			// 0644：用户 2026-10-30 要求这几个文件同机任何账户可读（写入也就写 0644）
			assert.equal((await stat(join(dir, "push-config.json"))).mode & 0o777, 0o644);

			// 空串 = 删掉这条配置（回兜底）
			await saveVapidSubject(dir, "  ");
			assert.deepEqual(await loadVapidSubject(dir), { subject: FALLBACK_VAPID_SUBJECT, source: "fallback" });
		});
	});
});

test("密钥首次使用自动生成并落盘 0600，且来源记成 file", async () => {
	await withoutEnv(async () => {
		await withDir(async (dir) => {
			const keys = await loadVapidKeys(dir);
			assert.equal(keys.source, "file");
			assert.ok(keys.publicKey.length > 40);
			assert.equal((await stat(join(dir, "vapid-keys.json"))).mode & 0o777, 0o644);
			// 第二次读的是同一把（不能每次调用都生成新的，否则订阅永远对不上）
			const again = await loadVapidKeys(dir);
			assert.equal(again.publicKey, keys.publicKey);
		});
	});
});

test("环境变量优先，并把「重新生成密钥」锁掉", async () => {
	const envKeys = (await import("web-push")).default.generateVAPIDKeys();
	process.env.VAPID_PUBLIC_KEY = envKeys.publicKey;
	process.env.VAPID_PRIVATE_KEY = envKeys.privateKey;
	process.env.VAPID_SUBJECT = "https://agent.example.com";
	try {
		await withDir(async (dir) => {
			const store = createPushStore({ dataDir: dir, now: () => 1 });
			const config = await store.config();
			assert.equal(config.keySource, "env");
			assert.equal(config.subject, "https://agent.example.com");
			assert.equal(config.subjectSource, "env");
			assert.equal(config.locked.keys, true);
			assert.equal(config.locked.subject, true);
			assert.deepEqual(await store.regenerateKeys(), { ok: false, code: "push.keys_locked" });
			// 被锁住时不许清订阅：「换了个寂寞」还把设备全整没了
			assert.equal(await store.count(), 0);
		});
	} finally {
		delete process.env.VAPID_PUBLIC_KEY;
		delete process.env.VAPID_PRIVATE_KEY;
		delete process.env.VAPID_SUBJECT;
	}
});

test("saveSubject：不合法的直接拒，合法的立刻生效且不动订阅", async () => {
	await withoutEnv(async () => {
		await withDir(async (dir) => {
			const store = createPushStore({ dataDir: dir, now: () => 1 });
			await store.add({ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" }, createdAt: 1 });

			assert.deepEqual(await store.saveSubject("me@localhost"), { ok: false, code: "push.subject.host" });
			// 拒了就不该落盘：仍然是不合法的兜底值
			assert.equal((await store.config()).subjectValid, false);

			const saved = await store.saveSubject("me@example.com");
			assert.equal(saved.ok, true);
			const config = await store.config();
			assert.equal(config.subject, "mailto:me@example.com");
			assert.equal(config.subjectValid, true);
			assert.equal(config.subjectSource, "file");
			// 改联系方式不该动订阅
			assert.equal(await store.count(), 1);
		});
	});
});

test("regenerateKeys：换一把新钥匙并清空旧订阅（它们已经不可能推通）", async () => {
	await withoutEnv(async () => {
		await withDir(async (dir) => {
			const logs: string[] = [];
			const store = createPushStore({ dataDir: dir, now: () => 1, log: (message) => logs.push(message) });
			const before = await store.publicKey();
			await store.add({ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" }, createdAt: 1 });
			await store.add({ endpoint: "https://push.example/b", keys: { p256dh: "p", auth: "a" }, createdAt: 1 });

			const result = await store.regenerateKeys();
			assert.equal(result.ok, true);
			assert.equal(result.cleared, 2);
			assert.equal(await store.count(), 0);
			assert.notEqual(await store.publicKey(), before);
			// 落盘的新钥匙要能重新读出来（不能只在内存里换）
			const saved = JSON.parse(await readFile(join(dir, "vapid-keys.json"), "utf8")) as { publicKey: string };
			assert.equal(saved.publicKey, await store.publicKey());
			assert.equal(logs.length, 1);
		});
	});
});
