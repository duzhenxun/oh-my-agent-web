/**
 * provider 存储（ADR-0025 §1）：写的是 pi 自己的两个文件。
 * 重点盯三件：**不存多余字段**、**不动别人的配置**、**权限 0600**。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_FILE, MODELS_STORE_FILE, createProviderStore } from "../../server/providers/provider-store.js";

let agentDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-web-providers-"));
	mkdirSync(agentDir, { recursive: true });
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const store = () => createProviderStore({ agentDir, now: () => 1700000000000 });

describe("list", () => {
	it("没有配置文件时返回空表（不抛）", async () => {
		expect(await store().list()).toEqual([]);
	});

	it("读出 provider，且**不含明文 key**", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({
				acme: { models: [{ id: "m1", name: "M1", api: "openai-completions", baseUrl: "https://a.example.com" }] },
			}),
		);
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-secret-abcd1234" } }));
		const [view] = await store().list();
		expect(view?.provider).toBe("acme");
		expect(view?.hasKey).toBe(true);
		expect(view?.keyHint).toBe("…1234");
		expect(JSON.stringify(view)).not.toContain("sk-secret");
	});
});

describe("upsert", () => {
	it("新增 provider：写模型表 + auth，权限 0600，其它 provider 不受影响", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ other: { models: [{ id: "keep-me" }] } }));
		const result = await store().upsert({
			provider: "acme",
			baseUrl: "https://a.example.com",
			api: "openai-completions",
			apiKey: "sk-1234567890",
			models: [{ id: "m1" }],
		});
		expect(result.ok).toBe(true);

		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8"));
		expect(Object.keys(models).sort()).toEqual(["acme", "other"]);
		expect(models.other.models[0].id).toBe("keep-me");
		expect(models.acme.models[0]).toMatchObject({ id: "m1", provider: "acme", api: "openai-completions" });
		expect(statSync(join(agentDir, MODELS_STORE_FILE)).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentDir, AUTH_FILE)).mode & 0o777).toBe(0o600);
	});

	it("不传 apiKey 时保留已有 key（留空 = 不修改）", async () => {
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-existing-9999" } }));
		await store().upsert({
			provider: "acme",
			baseUrl: "https://a.example.com",
			api: "openai-completions",
			models: [{ id: "m2" }],
		});
		const auth = JSON.parse(readFileSync(join(agentDir, AUTH_FILE), "utf8"));
		expect(auth.acme.key).toBe("sk-existing-9999");
	});

	it("新增 provider 但一个 key 都没有 → 拒绝（否则模型调不通）", async () => {
		const result = await store().upsert({
			provider: "acme",
			baseUrl: "https://a.example.com",
			api: "openai-completions",
			models: [{ id: "m1" }],
		});
		expect(result.ok).toBe(false);
	});

	it("只加一个模型时，原有模型不会被删掉", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({ acme: { models: [{ id: "old", cost: { input: 1 } }] } }),
		);
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-1234567890" } }));
		await store().upsert({
			provider: "acme",
			baseUrl: "https://a.example.com",
			api: "openai-completions",
			models: [{ id: "new" }],
		});
		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8"));
		expect(models.acme.models.map((model: { id: string }) => model.id).sort()).toEqual(["new", "old"]);
		// 原有字段也保留（成本等不该被我们覆盖掉）
		expect(models.acme.models.find((model: { id: string }) => model.id === "old").cost).toEqual({ input: 1 });
	});
});

describe("remove（B 期）", () => {
	it("删 provider 时模型表与凭证一起删，其它 provider 不受影响", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({ acme: { models: [{ id: "m1" }] }, keep: { models: [{ id: "m2" }] } }),
		);
		writeFileSync(
			join(agentDir, AUTH_FILE),
			JSON.stringify({
				acme: { type: "api_key", key: "sk-1234567890" },
				keep: { type: "api_key", key: "sk-0987654321" },
			}),
		);
		const result = await store().remove("acme");
		expect(result).toEqual({ ok: true, removed: true });
		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8"));
		const auth = JSON.parse(readFileSync(join(agentDir, AUTH_FILE), "utf8"));
		expect(Object.keys(models)).toEqual(["keep"]);
		expect(Object.keys(auth)).toEqual(["keep"]);
	});

	it("不存在的 provider：removed=false，不报错", async () => {
		expect(await store().remove("ghost")).toEqual({ ok: true, removed: false });
	});

	it("名字不合法的直接拒（防手滑写坏别人的配置）", async () => {
		expect((await store().remove("../etc")).ok).toBe(false);
	});
});

describe("readKey（只给服务端内部用）", () => {
	it("能读到明文 key；list 里没有它", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [{ id: "m1" }] } }));
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-abcdefgh" } }));
		expect(await store().readKey("acme")).toBe("sk-abcdefgh");
		const [view] = await store().list();
		expect(JSON.stringify(view)).not.toContain("sk-abcdefgh");
	});

	it("没有 key 时返回 null", async () => {
		expect(await store().readKey("nobody")).toBeNull();
	});
});

describe("updateModel（ADR-0026 A 期）", () => {
	it("写回规格与能力，其它字段（compat/成本）按规则保留或覆盖", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({ acme: { models: [{ id: "m1", name: "M1", compat: { supportsStore: true } }] } }),
		);
		const result = await store().updateModel("acme", {
			id: "m1",
			name: "M1 改名",
			reasoning: true,
			imageInput: true,
			contextWindow: 128000,
			maxTokens: 8192,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		});
		expect(result.ok).toBe(true);
		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8"));
		const model = models.acme.models[0];
		expect(model).toMatchObject({ id: "m1", name: "M1 改名", reasoning: true, contextWindow: 128000, maxTokens: 8192 });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 });
		expect(model.compat).toEqual({ supportsStore: true }); // 别的字段不该被我们抹掉
		expect(statSync(join(agentDir, MODELS_STORE_FILE)).mode & 0o777).toBe(0o600);
	});

	it("不勾能力时写回 text-only 且 reasoning=false", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [{ id: "m1" }] } }));
		await store().updateModel("acme", {
			id: "m1",
			name: "m1",
			reasoning: false,
			imageInput: false,
			contextWindow: null,
			maxTokens: null,
			cost: null,
		});
		const model = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).acme.models[0];
		expect(model.input).toEqual(["text"]);
		expect(model.reasoning).toBe(false);
		expect(model.contextWindow).toBeUndefined();
		expect(model.cost).toBeUndefined();
	});

	it("provider 或模型不存在 → 明确报错", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [{ id: "m1" }] } }));
		const noProvider = await store().updateModel("ghost", {
			id: "m1",
			name: "x",
			reasoning: false,
			imageInput: false,
			contextWindow: null,
			maxTokens: null,
			cost: null,
		});
		expect(noProvider.ok).toBe(false);
		const noModel = await store().updateModel("acme", {
			id: "nope",
			name: "x",
			reasoning: false,
			imageInput: false,
			contextWindow: null,
			maxTokens: null,
			cost: null,
		});
		expect(noModel.ok).toBe(false);
	});
});

describe("removeModel（从 provider 下移除模型）", () => {
	it("只删这一个模型，其它模型与凭证都留着", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({ acme: { models: [{ id: "m1" }, { id: "m2" }] } }),
		);
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-abcdefgh" } }));
		const result = await store().removeModel("acme", "m1");
		expect(result.ok).toBe(true);
		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8"));
		expect(models.acme.models.map((model: { id: string }) => model.id)).toEqual(["m2"]);
		expect(JSON.parse(readFileSync(join(agentDir, AUTH_FILE), "utf8")).acme.key).toBe("sk-abcdefgh");
		expect(statSync(join(agentDir, MODELS_STORE_FILE)).mode & 0o777).toBe(0o600);
	});

	it("模型或 provider 不存在 → 明确报错（不乱写文件）", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [{ id: "m1" }] } }));
		expect((await store().removeModel("acme", "ghost")).ok).toBe(false);
		expect((await store().removeModel("ghost", "m1")).ok).toBe(false);
	});
});

describe("list 带逐模型规格（编辑器预填）", () => {
	it("reasoning / 图片输入 / 规格 / 价格都读回来", async () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({
				acme: {
					models: [
						{
							id: "m1",
							name: "M1",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 1000000,
							maxTokens: 384000,
							cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			}),
		);
		const view = await store().get("acme");
		expect(view?.models[0]).toMatchObject({
			id: "m1",
			name: "M1",
			reasoning: true,
			imageInput: true,
			contextWindow: 1000000,
			maxTokens: 384000,
			cost: { input: 0.1, output: 0.4 },
		});
	});

	it("没配过的模型不编造规格（不给 0、不给 false 之外的假值）", async () => {
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [{ id: "m1" }] } }));
		const model = (await store().get("acme"))?.models[0];
		expect(model?.imageInput).toBe(false);
		expect(model?.contextWindow).toBeUndefined();
		expect(model?.cost).toBeUndefined();
	});
});
