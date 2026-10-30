/**
 * 「有没有新版」的检测（启动提示 + `aw status`）。
 *
 * 要守住四件事：
 *   1. 版本比较按 semver 够用的部分：数字段优先、正式版比预发布版新、`v` 前缀能认；
 *   2. 缓存新鲜（6h 内）就**不问网络** —— 敲一次 `aw` 不该打一次 npm；
 *      但缓存里的 `latest` 比本机还旧时不信它（那说明这次查的结果本来就不可信）；
 *   3. 查不到（断网 / registry 不通）就静默返回 null，绝不抛错，也不写坏缓存；
 *   4. 能关：`AGENT_WEB_UPDATE_CHECK=off`。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkForUpdate, describeUpdate, isNewerVersion } from "../../server/update-check.ts";

const dataDirOf = (): string => mkdtempSync(join(tmpdir(), "omaw-update-"));

/** 假 registry：只回一个 `{"version": …}`，用来验「真去查了」的那几条路径 */
async function startFakeRegistry(version: string): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ name: "oh-my-agent-web", version }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** 临时改环境变量，出了这段就还原（测试之间不串味） */
function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
	const backup = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) process.env[key] = value;
	return run().finally(() => {
		for (const [key, value] of backup) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

describe("版本比较", () => {
	it("数字段决定新旧", () => {
		assert.equal(isNewerVersion("1.0.2", "1.0.1"), true);
		assert.equal(isNewerVersion("1.0.1", "1.0.2"), false);
		assert.equal(isNewerVersion("1.0.1", "1.0.1"), false);
		assert.equal(isNewerVersion("1.1.0", "1.0.9"), true);
		assert.equal(isNewerVersion("2.0", "1.9.9"), true);
		assert.equal(isNewerVersion("v1.2.3", "1.2.2"), true);
	});

	it("正式版比预发布版新", () => {
		assert.equal(isNewerVersion("1.0.0", "1.0.0-rc.1"), true);
		assert.equal(isNewerVersion("1.0.0-rc.1", "1.0.0"), false);
		assert.equal(isNewerVersion("1.0.0-rc.2", "1.0.0-rc.1"), true);
	});
});

describe("提示文案", () => {
	it("没有新版就不说话", () => {
		assert.equal(describeUpdate(null), null);
		assert.equal(describeUpdate({ current: "1.0.1", latest: "1.0.1", hasUpdate: false }), null);
	});

	it("有新版本时给出升级命令", () => {
		const line = describeUpdate({ current: "1.0.1", latest: "1.0.2", hasUpdate: true });
		assert.ok(line?.includes("v1.0.2"));
		assert.ok(line?.includes("aw upgrade"));
	});
});

describe("缓存与网络", () => {
	it("缓存新鲜时不问网络，直接用缓存里的版本", async () => {
		const dataDir = dataDirOf();
		writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checkedAt: 1_000, latest: "9.9.9" }));
		const result = await withEnv({ AGENT_WEB_NPM_REGISTRY: "http://127.0.0.1:1" }, () =>
			checkForUpdate({ dataDir, now: () => 2_000 }),
		);
		assert.equal(result?.latest, "9.9.9");
		assert.equal(result?.hasUpdate, true);
	});

	it("缓存里的 latest 比本机还旧 → 不信缓存，当场重查（自愈）", async () => {
		const dataDir = dataDirOf();
		// 模拟「以前换过镜像 / 发版前查到的旧值」：缓存新鲜（within 6h），但内容是 0.0.1
		writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checkedAt: 1_000, latest: "0.0.1" }));
		const registry = await startFakeRegistry("9.9.9");
		try {
			const result = await withEnv({ AGENT_WEB_NPM_REGISTRY: registry.url }, () =>
				checkForUpdate({ dataDir, now: () => 2_000 }),
			);
			assert.equal(result?.latest, "9.9.9");
			assert.equal(result?.hasUpdate, true);
		} finally {
			await registry.close();
		}
	});

	it("缓存只保鲜 6 小时：发完版半小时内就能提示，不用等一天", async () => {
		const dataDir = dataDirOf();
		writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checkedAt: 1_000, latest: "9.9.9" }));
		const sevenHoursLater = 1_000 + 7 * 60 * 60 * 1000;
		// 过期 + registry 不通 → null（说明确实重新查了，而不是拿缓存充数）
		const result = await withEnv({ AGENT_WEB_NPM_REGISTRY: "http://127.0.0.1:1" }, () =>
			checkForUpdate({ dataDir, now: () => sevenHoursLater }),
		);
		assert.equal(result, null);
	});

	it("缓存过期且 registry 不通 → 静默返回 null，不写坏缓存", async () => {
		const dataDir = dataDirOf();
		writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checkedAt: 1_000, latest: "9.9.9" }));
		const dayLater = 1_000 + 25 * 60 * 60 * 1000;
		const result = await withEnv({ AGENT_WEB_NPM_REGISTRY: "http://127.0.0.1:1" }, () =>
			checkForUpdate({ dataDir, now: () => dayLater }),
		);
		assert.equal(result, null);
	});

	it("AGENT_WEB_UPDATE_CHECK=off 直接不查", async () => {
		const result = await withEnv({ AGENT_WEB_UPDATE_CHECK: "off" }, () =>
			checkForUpdate({ dataDir: dataDirOf(), now: () => 2_000 }),
		);
		assert.equal(result, null);
	});
});
