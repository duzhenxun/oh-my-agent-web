/**
 * 导入模型时顺手填规格（`import-routes.ts` 的 `POST /api/providers/:provider/import`）。
 *
 * 规则：
 *   - 新加的模型：models.dev 查得到 → 写入上下文窗口 / 最大输出 / 价格 / 推理 / 图片输入；查不到 → 留空（`notFound`）；
 *   - 已存在的模型（`skipped`）：一律不动，保留用户已经填过的值。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { registerImportRoutes } from "../../server/providers/import-routes.ts";
import { createProviderStore } from "../../server/providers/provider-store.ts";

let dir = "";
let server: import("node:http").Server | null = null;
let base = "";

describe("导入模型时填入规格", () => {
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "import-fill-"));
		// ChatGPT Plus/Pro 形状：models.json 里有模型，models-store 里是空数组（目录型导入）
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({ providers: { "openai-codex": { models: [{ id: "gpt-6-luna", name: "Luna 6" }] } } }),
		);
		await writeFile(join(dir, "models-store.json"), JSON.stringify({ "openai-codex": { models: [] } }));
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 0, accountId: "x" } }),
		);
		const store = createProviderStore({ agentDir: dir, now: () => 0 });
		const app = express();
		app.use(express.json());
		registerImportRoutes(app, {
			store,
			catalog: async (modelId) =>
				modelId === "gpt-7-test"
					? {
							name: "GPT 7 Test",
							contextWindow: 400000,
							maxTokens: 128000,
							reasoning: true,
							imageInput: true,
							cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
						}
					: null,
		});
		server = app.listen(0);
		await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		server?.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("新模型按 models.dev 填规格；查不到的留空并列入 notFound；已存在的不覆盖", async () => {
		const response = await fetch(`${base}/api/providers/openai-codex/import`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: ["gpt-7-test", "gpt-8-none", "gpt-6-luna"] }),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as { added: string[]; skipped: string[]; filled: string[]; notFound: string[] };
		assert.deepEqual(body.added.sort(), ["gpt-7-test", "gpt-8-none"]);
		assert.deepEqual(body.skipped, ["gpt-6-luna"]);
		assert.deepEqual(body.filled, ["gpt-7-test"]);
		assert.deepEqual(body.notFound, ["gpt-8-none"]);

		const catalog = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
		const models = catalog.providers["openai-codex"].models as Array<Record<string, unknown>>;
		const filled = models.find((model) => model.id === "gpt-7-test");
		assert.ok(filled, "新模型要写进 models.json");
		assert.equal(filled.name, "GPT 7 Test");
		assert.equal(filled.contextWindow, 400000);
		assert.equal(filled.maxTokens, 128000);
		assert.equal(filled.reasoning, true);
		assert.deepEqual(filled.input, ["text", "image"]);
		assert.deepEqual(filled.cost, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 });

		const untouched = models.find((model) => model.id === "gpt-6-luna");
		assert.equal(untouched?.name, "Luna 6", "已存在的模型不能被覆盖");
		const blank = models.find((model) => model.id === "gpt-8-none");
		assert.ok(blank, "查不到规格的模型照样导入");
		assert.equal(blank.contextWindow, undefined, "查不到就留空，不猜");
	});
});
