/**
 * 删除模型必须把**两个文件**都清掉（`server/providers/provider-store.ts` 的 `removeModel`）。
 *
 * 用户报的现象：某个模型「早都删掉了」，界面上却老是回来（截图里的 TYPESAFE / Jev）。
 *
 * 根因：同一个 provider 可能同时存在于
 *   - `models.json`（pi 自己的目录，**真正的源头**，pi 的 `listModels()` 从这里读）
 *   - `models-store.json`（历史位置，也是 pi 的动态目录缓存）
 * 而 `removeModel` 以前只删后者。pi 那边纹丝不动，下一次列模型又把它报上来 —— 于是「删不干净」。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createProviderStore } from "../../server/providers/provider-store.ts";

const MODEL = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "https://api.typesafe.ai/v1/",
};

async function withAgentDir(
	files: { models?: unknown; modelsStore?: unknown },
	run: (agentDir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "prov-remove-"));
	try {
		await writeFile(join(dir, "models.json"), JSON.stringify(files.models ?? { providers: {} }));
		await writeFile(join(dir, "models-store.json"), JSON.stringify(files.modelsStore ?? {}));
		await writeFile(join(dir, "auth.json"), JSON.stringify({}));
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const readModels = async (dir: string, file: string) =>
	JSON.parse(await readFile(join(dir, file), "utf8")) as {
		providers?: Record<string, { models?: { id: string }[] }>;
	} & Record<string, { models?: { id: string }[] }>;

describe("removeModel：两个文件都要清", () => {
	it("provider 同时在 models.json 与 models-store.json —— 删完之后两边都没有它", async () => {
		await withAgentDir(
			{
				models: { providers: { typesafe: { baseUrl: MODEL.baseUrl, api: MODEL.api, models: [MODEL] } } },
				modelsStore: { typesafe: { models: [MODEL], lastModified: 1 } },
			},
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 2 });
				const result = await store.removeModel("typesafe", "jev-latest");
				assert.deepEqual(result, { ok: true });

				const catalog = await readModels(agentDir, "models.json");
				const storeFile = await readModels(agentDir, "models-store.json");
				const catalogIds = (catalog.providers?.typesafe?.models ?? []).map((model) => model.id);
				const storeIds = ((storeFile.typesafe as { models?: { id: string }[] } | undefined)?.models ?? []).map(
					(model) => model.id,
				);
				assert.deepEqual(catalogIds, [], "models.json（pi 的源头）里还留着这个模型 → pi 会继续报它");
				assert.deepEqual(storeIds, [], "models-store.json 里还留着");
			},
		);
	});

	it("provider 只在 models.json 里 —— 同样能删（不必先把它搬进 models-store.json）", async () => {
		await withAgentDir(
			{ models: { providers: { typesafe: { baseUrl: MODEL.baseUrl, api: MODEL.api, models: [MODEL] } } } },
			async (agentDir) => {
				const store = createProviderStore({ agentDir, now: () => 2 });
				assert.deepEqual(await store.removeModel("typesafe", "jev-latest"), { ok: true });
				const catalog = await readModels(agentDir, "models.json");
				assert.deepEqual(catalog.providers?.typesafe?.models ?? [], []);
			},
		);
	});

	it("哪里都没有这个模型 → 明确报错（不是假装成功）", async () => {
		await withAgentDir({}, async (agentDir) => {
			const store = createProviderStore({ agentDir, now: () => 2 });
			const result = await store.removeModel("typesafe", "jev-latest");
			assert.equal("error" in result, true);
		});
	});
});
