/**
 * 推送订阅里的「这台设备的界面自称」（`server/push/push.ts` 的 `add` / `setBrandName`）。
 *
 * 这份状态有三个容易踩的边界，都跟「重新订阅」有关：
 *   1. 设备别名与自称都是**用户改过的**，重新订阅不能把它们冲回默认；
 *   2. 「没传 brandName」＝ 老客户端 / 只是重订阅 → 保留原值；
 *      「传了空串」＝ 改回产品默认名 → 把字段删掉；
 *   3. 都不该影响别的设备。
 *
 * 不碰网络：只看落盘的那份 json（send 才会真的推）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPushStore } from "../../server/push/push.ts";

async function withStore(run: (store: ReturnType<typeof createPushStore>, path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "omaw-push-"));
	const path = join(dir, "push-subscriptions.json");
	try {
		await run(createPushStore({ dataDir: dir, now: () => 1_700_000_000_000 }), path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const sub = (endpoint: string, extra: Record<string, unknown> = {}) => ({
	endpoint,
	keys: { p256dh: "p", auth: "a" },
	createdAt: 1,
	...extra,
});

test("订阅时带上名字：原样落盘", async () => {
	await withStore(async (store, path) => {
		await store.add(sub("https://push.example/a", { name: "Mac · Chrome", brandName: "我的智能体" }));
		const saved = JSON.parse(await readFile(path, "utf8")) as { brandName?: string }[];
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.brandName, "我的智能体");
	});
});

test("重新订阅（没再传名字）：保留用户改过的名字与别名", async () => {
	await withStore(async (store, path) => {
		await store.add(sub("https://push.example/a", { name: "我的 Mac", brandName: "我的智能体" }));
		// 老客户端 / 只重订阅：完全不提 brandName，name 也换回了默认值
		await store.add(sub("https://push.example/a", { name: "Mac · Chrome" }));
		const saved = JSON.parse(await readFile(path, "utf8")) as { name?: string; brandName?: string }[];
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.name, "我的 Mac");
		assert.equal(saved[0]?.brandName, "我的智能体");
	});
});

test("改回默认名：字段直接删掉，而不是存一个空串", async () => {
	await withStore(async (store, path) => {
		await store.add(sub("https://push.example/a", { brandName: "我的智能体" }));
		await store.setBrandName("https://push.example/a", "");
		const saved = JSON.parse(await readFile(path, "utf8")) as { brandName?: string }[];
		assert.equal("brandName" in (saved[0] ?? {}), false);
	});
});

test("重新订阅时传空串：等同于清掉名字", async () => {
	await withStore(async (store, path) => {
		await store.add(sub("https://push.example/a", { brandName: "我的智能体" }));
		await store.add(sub("https://push.example/a", { brandName: "" }));
		const saved = JSON.parse(await readFile(path, "utf8")) as { brandName?: string }[];
		assert.equal("brandName" in (saved[0] ?? {}), false);
	});
});

test("同步名字只动那一台设备", async () => {
	await withStore(async (store) => {
		await store.add(sub("https://push.example/a", { brandName: "甲" }));
		await store.add(sub("https://push.example/b", { brandName: "乙" }));
		await store.setBrandName("https://push.example/a", "甲2");
		const list = await store.list();
		assert.deepEqual(
			list.map((item) => item.brandName),
			["甲2", "乙"],
		);
	});
});
