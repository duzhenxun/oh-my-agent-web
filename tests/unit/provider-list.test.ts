/**
 * 服务商列表：**同 URL 的两个服务商必须都出现**（`server/providers/provider-store.ts` 的 `list()`）。
 *
 * 用户报的现象：分了两次添加（`deepseek` 与 `deepseek-office`，baseUrl 都是
 * `https://api.deepseek.com`），对话里的模型选择器两个都在，**配置面板只出现一个**。
 *
 * 根因：`deepseek` 同时写在两个文件里（`models-store.json` 是历史位置、`models.json` 是 pi 自己的目录）。
 * `list()` 把 provider 分成 custom（读 models-store.json）与 fromCatalog（读 models.json）两拨，
 * 后者会跳过「models-store.json 里已有」的 provider —— 于是 `deepseek` 走 custom 分支，
 * 而那个分支当时只从 `auth.json` 找凭证，**没看 models.json 里的 apiKey** →
 * credential 被算成 `none` → 面板的「只列能用的」把它藏了。
 *
 * 这里用临时目录造出「同一份配置同时存在于两个文件」的场景，锁住行为。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { builtinProviderGroups } from "../../server/providers/provider-handlers.ts";
import { createProviderStore } from "../../server/providers/provider-store.ts";

const SAME_URL = "https://api.deepseek.com";

/** 引擎报上来的模型（`provider/model` 形状）—— 与真实 listModels() 的产出对齐 */
const engineModels = [
	...["deepseek-flash", "deepseek-v4-pro"].map((id) => ({
		id: `deepseek/${id}`,
		label: id,
		baseUrl: SAME_URL,
		api: "openai-completions",
	})),
	...["deepseek-flash", "deepseek-v4-pro"].map((id) => ({
		id: `deepseek-office/${id}`,
		label: id,
		baseUrl: SAME_URL,
		api: "openai-completions",
	})),
];

const usable = (view: { credential: string }) => view.credential === "apiKey" || view.credential === "oauth";

async function withAgentDir(
	files: { models?: unknown; modelsStore?: unknown; auth?: unknown },
	run: (agentDir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "prov-list-"));
	try {
		if (files.models !== undefined) await writeFile(join(dir, "models.json"), JSON.stringify(files.models));
		if (files.modelsStore !== undefined)
			await writeFile(join(dir, "models-store.json"), JSON.stringify(files.modelsStore));
		if (files.auth !== undefined) await writeFile(join(dir, "auth.json"), JSON.stringify(files.auth));
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("provider list：同一个 baseUrl 的两个服务商", () => {
	it("一个在 models.json、一个同时也在 models-store.json —— 两个都要出现且都算「有 key」", async () => {
		await withAgentDir(
			{
				// pi 自己的目录：两个服务商都在，各自带着自己的 apiKey
				models: {
					providers: {
						deepseek: {
							baseUrl: SAME_URL,
							api: "openai-completions",
							apiKey: "sk-deepseek-office-key",
							models: [{ id: "deepseek-flash" }],
						},
						"deepseek-office": {
							baseUrl: SAME_URL,
							api: "openai-completions",
							apiKey: "sk-deepseek-office-key",
							models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
						},
					},
				},
				// 历史位置：只有 deepseek（也就是之前把它藏起来的那个分支）
				modelsStore: {
					deepseek: {
						models: [
							{ id: "deepseek-flash", baseUrl: SAME_URL, api: "openai-completions" },
							{ id: "deepseek-v4-pro", baseUrl: SAME_URL, api: "openai-completions" },
						],
					},
				},
				// auth.json 里一个都没有：凭证只在 models.json 里
				auth: {},
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const views = await store.list(builtinProviderGroups(engineModels));
				const deepseekViews = views.filter((view) => view.provider.startsWith("deepseek"));
				const visible = deepseekViews.filter(usable);

				assert.deepEqual(
					visible.map((view) => view.provider).sort(),
					["deepseek", "deepseek-office"],
					"同一个 baseUrl 的两个服务商必须各占一行",
				);
				for (const view of visible) {
					assert.equal(view.baseUrl, SAME_URL);
					assert.ok(view.keyHint, `${view.provider} 应该能报出 key 提示`);
				}
			},
		);
	});

	it("反向确认：两个文件里都没有 key → 确实算「没配置」（不是把所有都放行）", async () => {
		await withAgentDir(
			{
				models: {
					providers: {
						"deepseek-office": { baseUrl: SAME_URL, api: "openai-completions", models: [{ id: "deepseek-flash" }] },
					},
				},
				modelsStore: { deepseek: { models: [{ id: "deepseek-flash", baseUrl: SAME_URL }] } },
				auth: {},
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const views = await store.list(builtinProviderGroups(engineModels));
				const visible = views.filter((view) => view.provider.startsWith("deepseek")).filter(usable);
				assert.deepEqual(
					visible.map((view) => view.provider),
					[],
				);
			},
		);
	});

	it("auth.json 里有 key 的仍然优先（不会被 catalog 的 key 覆盖掉判断）", async () => {
		await withAgentDir(
			{
				models: { providers: {} },
				modelsStore: {
					deepseek: { models: [{ id: "deepseek-flash", baseUrl: SAME_URL, api: "openai-completions" }] },
				},
				auth: { deepseek: { type: "api_key", key: "sk-from-auth-json" } },
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const views = await store.list(builtinProviderGroups(engineModels));
				const deepseek = views.find((view) => view.provider === "deepseek");
				assert.equal(deepseek?.credential, "apiKey");
				assert.ok(deepseek?.keyHint?.endsWith("json"), "应当用的是 auth.json 里那把 key");
			},
		);
	});
});
