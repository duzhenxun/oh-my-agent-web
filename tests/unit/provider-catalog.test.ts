/**
 * pi 的 provider 目录（models.json）：nexita 这类 provider 住在这里，
 * 改动必须写回这份文件（而不是另建一份 models-store 覆盖条目）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptRename, migrateStoreToCatalog } from "../../server/providers/catalog-writes.js";
import { MODELS_STORE_FILE, createProviderStore } from "../../server/providers/provider-store.js";

let agentDir = "";
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-web-catalog-"));
	mkdirSync(agentDir, { recursive: true });
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
const store = () => createProviderStore({ agentDir, now: () => 1700000000000 });

describe("目录里的 provider 也能改（写回 models.json，不另建覆盖条目）", () => {
	const catalog = {
		providers: {
			nexita: {
				api: "openai-responses",
				baseUrl: "https://codeapi.nexita.net/v1",
				apiKey: "sk-catalog",
				models: [
					{ id: "gpt-6", name: "GPT-6" },
					{ id: "gpt-6-luna", name: "GPT-6 Luna" },
				],
			},
		},
	};

	it("改模型规格写回 models.json，models-store 不动", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		const result = await store().updateModel("nexita", {
			id: "gpt-6",
			name: "GPT-6 改名",
			reasoning: true,
			imageInput: true,
			contextWindow: 200000,
			maxTokens: 8192,
			cost: null,
		});
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(after.providers.nexita.models[0]).toMatchObject({
			id: "gpt-6",
			name: "GPT-6 改名",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
		});
		expect(after.providers.nexita.apiKey).toBe("sk-catalog"); // key 不能被抹掉
		expect(statSync(join(agentDir, "models.json")).mode & 0o777).toBe(0o600);
		// 不该在 models-store 里造覆盖条目
		expect(() => readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).toThrow();
	});

	it("移除模型也只动目录里的这一个", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		expect((await store().removeModel("nexita", "gpt-6")).ok).toBe(true);
		const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(after.providers.nexita.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6-luna"]);
	});
});

describe("内置 provider 的「导入模型」", () => {
	const catalog = {
		providers: {
			nexita: { api: "openai-responses", baseUrl: "https://x/v1", models: [{ id: "m1", name: "M1" }] },
		},
	};

	it("追加到 models.json：只加不存在的，已有的跳过", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		const result = await store().addModels("nexita", ["m1", "m2"]);
		expect(result).toEqual({ ok: true, added: ["m2"], skipped: ["m1"] });
		const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(after.providers.nexita.models.map((model: { id: string }) => model.id)).toEqual(["m1", "m2"]);
		expect(after.providers.nexita.api).toBe("openai-responses"); // 其它字段不动
	});
});

describe("删除 provider：三处都要清", () => {
	const catalog = {
		providers: { dup: { api: "openai-completions", baseUrl: "https://x", apiKey: "sk-a", models: [{ id: "m1" }] } },
	};

	it("两份文件里都有时，两处都要删掉（否则刷新后又冒出来 = 删不掉）", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ dup: { models: [{ id: "m1" }] } }));
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ dup: { type: "api_key", key: "sk-a" } }));

		const result = await store().remove("dup");
		expect(result).toEqual({ ok: true, removed: true });
		expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers.dup).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).dup).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).dup).toBeUndefined();
	});

	it("只在 auth.json 里有（历史上留下的孤儿 key）也能删干净", async () => {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ orphan: { type: "api_key", key: "sk-b" } }));
		expect(await store().remove("orphan")).toEqual({ ok: true, removed: true });
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).orphan).toBeUndefined();
	});

	it("三处都没有 → removed:false（界面据此提示「可能是插件注册的」）", async () => {
		expect(await store().remove("ghost")).toEqual({ ok: true, removed: false });
	});
});

describe("新 provider 写进 models.json（pi CLI 只认这份）", () => {
	it("upsert 新 provider → models.json 里出现，models-store 里没有", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		const result = await store().upsert({
			provider: "new-gw",
			baseUrl: "https://x/v1",
			api: "openai-completions",
			apiKey: "sk-new-1234",
			models: [{ id: "m1" }, { id: "m2" }],
		});
		expect(result.ok).toBe(true);
		const catalog = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(catalog.providers["new-gw"]).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://x/v1",
			apiKey: "sk-new-1234",
		});
		expect(catalog.providers["new-gw"].models.map((model: { id: string }) => model.id)).toEqual(["m1", "m2"]);
		expect(() => readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).toThrow();
	});
});

describe("把老 provider 补进 models.json（幂等，不删原文件）", () => {
	it("models-store 里的 provider 补一份到目录，key 从 auth.json 带上", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({ old: { models: [{ id: "m1", api: "openai-completions", baseUrl: "https://old/v1" }] } }),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ old: { key: "sk-old" } }));

		const migrated = await migrateStoreToCatalog(agentDir);
		expect(migrated).toEqual(["old"]);
		const catalog = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(catalog.providers.old).toMatchObject({
			baseUrl: "https://old/v1",
			api: "openai-completions",
			apiKey: "sk-old",
		});
		// 原来的文件不动（迁移失败也不会更糟）
		expect(JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).old).toBeDefined();
		// 再跑一次：已经在了，不再重复迁移
		expect(await migrateStoreToCatalog(agentDir)).toEqual([]);
	});
});

describe("改名（编辑 provider 时改了名字）", () => {
	it("旧条目搬走、新条目落下，key 跟着走", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { old: { api: "openai-completions", baseUrl: "https://x", apiKey: "sk-1", models: [{ id: "m1" }] } },
			}),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ old: { key: "sk-1" } }));

		const moved = await adoptRename(agentDir, "old", "renamed");
		expect(moved).toBe("sk-1"); // 返回旧 key 供调用方兜底

		const catalog = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(catalog.providers.old).toBeUndefined();
		expect(catalog.providers.renamed).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://x",
			apiKey: "sk-1",
		});
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).old).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).renamed.key).toBe("sk-1");
	});

	it("upsert 带 previousProvider：不会既留旧的又多一个新的", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { old: { api: "openai-completions", baseUrl: "https://x", apiKey: "sk-1", models: [{ id: "m1" }] } },
			}),
		);
		const result = await store().upsert({
			provider: "renamed",
			previousProvider: "old",
			baseUrl: "https://x",
			api: "openai-completions",
			models: [{ id: "m1" }],
		});
		expect(result.ok).toBe(true);
		const catalog = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers;
		expect(Object.keys(catalog)).toEqual(["renamed"]);
		expect(catalog.renamed.apiKey).toBe("sk-1"); // 没填新 key 也不能丢
	});
});
