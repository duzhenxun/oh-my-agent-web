/**
 * 导入模型（ADR-0026 B 期）：只读拉清单 + 批量追加（不覆盖已有模型）。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listRemoteModels } from "../../server/providers/import-models.js";
import { createProviderStore, MODELS_STORE_FILE, AUTH_FILE } from "../../server/providers/provider-store.js";

let server: Server;
let port = 0;
let agentDir = "";

beforeAll(async () => {
	server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ data: [{ id: "m-b" }, { id: "m-a", owned_by: "acme" }, { id: "m-a" }] }));
			return;
		}
		response.writeHead(401).end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-web-import-"));
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("listRemoteModels", () => {
	it("解析 OpenAI 兼容的 { data: [...] }，去重并排序", async () => {
		const result = await listRemoteModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-1234567890" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.models.map((model) => model.id)).toEqual(["m-a", "m-b"]);
		expect(result.models[0]?.ownedBy).toBe("acme");
	});

	it("401 → 说明 key 可能不对", async () => {
		const result = await listRemoteModels({ baseUrl: `http://127.0.0.1:${port}/bad`, apiKey: "sk-1234567890" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("key 可能不对");
	});

	it("非 http(s) 直接拒", async () => {
		expect((await listRemoteModels({ baseUrl: "file:///etc", apiKey: "sk-1234567890" })).ok).toBe(false);
	});
});

describe("addModels", () => {
	const seed = () => {
		writeFileSync(
			join(agentDir, MODELS_STORE_FILE),
			JSON.stringify({
				acme: {
					models: [{ id: "m-a", api: "openai-completions", baseUrl: "https://a.example.com", contextWindow: 128000 }],
				},
			}),
		);
		writeFileSync(join(agentDir, AUTH_FILE), JSON.stringify({ acme: { type: "api_key", key: "sk-1234567890" } }));
	};
	const store = () => createProviderStore({ agentDir, now: () => 1700000000000 });

	it("只追加不存在的；已有模型（含手填的规格）不被覆盖", async () => {
		seed();
		const result = await store().addModels("acme", ["m-a", "m-b"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.added).toEqual(["m-b"]);
		expect(result.skipped).toEqual(["m-a"]);
		const models = JSON.parse(readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).acme.models;
		expect(models.find((model: { id: string }) => model.id === "m-a").contextWindow).toBe(128000);
		expect(models.find((model: { id: string }) => model.id === "m-b")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://a.example.com",
		});
	});

	it("provider 不存在 / 没有可参考的 api+baseUrl → 明确报错", async () => {
		expect((await store().addModels("ghost", ["x"])).ok).toBe(false);
		writeFileSync(join(agentDir, MODELS_STORE_FILE), JSON.stringify({ acme: { models: [] } }));
		expect((await store().addModels("acme", ["x"])).ok).toBe(false);
	});
});
