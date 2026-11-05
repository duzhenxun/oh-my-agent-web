/**
 * 同一个 provider 同时在 models-store.json 与 models.json 里：模型取**并集**（`provider-store.ts` 的 `list()`）。
 *
 * 用户报的现象：ChatGPT Plus/Pro（provider `openai-codex`）订阅登录了，导入过 gpt-5.6-luna 等模型，
 * 面板里那一行下面却什么都没有。根因：models-store.json 里 `openai-codex` 是空数组，
 * `list()` 只认它、把 models.json 里的模型整份丢掉。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createProviderStore } from "../../server/providers/provider-store.ts";

async function withAgentDir(
	files: { models?: unknown; modelsStore?: unknown; auth?: unknown },
	run: (agentDir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "prov-merge-"));
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

describe("provider list：两个文件的模型取并集", () => {
	it("models-store 里是空数组、models.json 里有导入的模型 → 模型要看得见（openai-codex 场景）", async () => {
		await withAgentDir(
			{
				models: {
					providers: {
						"openai-codex": { models: [{ id: "gpt-5.6-luna" }, { id: "gpt-6-luna" }] },
					},
				},
				modelsStore: { "openai-codex": { models: [] } },
				auth: { "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 0, accountId: "x" } },
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const view = (await store.list()).find((item) => item.provider === "openai-codex");
				assert.ok(view, "openai-codex 必须在列表里");
				assert.deepEqual(
					view.models.map((model) => model.id),
					["gpt-5.6-luna", "gpt-6-luna"],
				);
				assert.equal(view.credential, "oauth");
			},
		);
	});

	it("两边都有的模型按 id 去重，models-store 的条目排在前面", async () => {
		await withAgentDir(
			{
				models: { providers: { kimi: { models: [{ id: "k3" }, { id: "k3-256k" }] } } },
				modelsStore: { kimi: { models: [{ id: "k3", name: "K3 (store)" }] } },
				auth: {},
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const view = (await store.list()).find((item) => item.provider === "kimi");
				assert.ok(view);
				assert.deepEqual(
					view.models.map((model) => model.id),
					["k3", "k3-256k"],
				);
				assert.equal(view.models[0]?.name, "K3 (store)");
			},
		);
	});

	it("模型只在 models.json 里：保存规格要写回 models.json（不能报「这个 provider 下没有模型」）", async () => {
		await withAgentDir(
			{
				models: { providers: { "openai-codex": { models: [{ id: "gpt-5.6-luna", name: "Luna" }] } } },
				modelsStore: { "openai-codex": { models: [] } },
				auth: {},
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 0 });
				const result = await store.updateModel(
					"openai-codex",
					{
						id: "gpt-5.6-luna",
						name: "Luna 2",
						reasoning: true,
						imageInput: false,
						contextWindow: 1050000,
						maxTokens: 128000,
						cost: null,
						costSchedule: null,
					} as never,
				);
				assert.deepEqual(result, { ok: true });
				const catalog = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
				const saved = catalog.providers["openai-codex"].models.find((model: { id: string }) => model.id === "gpt-5.6-luna");
				assert.equal(saved.name, "Luna 2");
				assert.equal(saved.contextWindow, 1050000);
			},
		);
	});
});
