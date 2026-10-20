/**
 * 连通性测试（B 期）：只打一次 GET /models。
 * 盯三件：成功后返回状态与耗时、失败信息**不含 key**、超时能及时返回。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRemoteModels } from "../../server/providers/import-models.js";
import { probeProvider, verifyProviderConfig } from "../../server/providers/probe.js";

let server: Server;
let port = 0;

beforeAll(async () => {
	server = createServer((request, response) => {
		const auth = request.headers.authorization ?? "";
		if (request.url === "/ok/models") {
			response.writeHead(200).end(JSON.stringify({ data: [] }));
			return;
		}
		if (request.url === "/badkey/models") {
			response.writeHead(401).end("{}");
			return;
		}
		if (request.url === "/slow/models") {
			// 永不响应，用来验超时
			return;
		}
		response.writeHead(404).end("{}");
		void auth;
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("probeProvider", () => {
	it("200 → 通，并给出耗时", async () => {
		const result = await probeProvider({ baseUrl: `http://127.0.0.1:${port}/ok`, apiKey: "sk-1234567890" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe(200);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("401 → 不通，但说明「地址可达，key 可能不对」", async () => {
		const result = await probeProvider({ baseUrl: `http://127.0.0.1:${port}/badkey`, apiKey: "sk-1234567890" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("401");
		expect(result.message).toContain("key 可能不对");
	});

	it("连不上时不泄露关键信息（只报主机名）", async () => {
		const result = await probeProvider({
			baseUrl: "http://127.0.0.1:9/dead",
			apiKey: "sk-super-secret-9999",
			timeoutMs: 1500,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).not.toContain("sk-super-secret");
	});

	it("超时会及时返回，不吊死界面", async () => {
		const started = Date.now();
		const result = await probeProvider({
			baseUrl: `http://127.0.0.1:${port}/slow`,
			apiKey: "sk-1234567890",
			timeoutMs: 300,
		});
		expect(result.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("非 http(s) 直接拒（旧文件里的脏数据也挡得住）", async () => {
		const result = await probeProvider({ baseUrl: "file:///etc", apiKey: "sk-1234567890" });
		expect(result.ok).toBe(false);
	});
});

describe("verifyProviderConfig：保存前先验证", () => {
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	it("列表就不通 → step=models，且不再发对话请求", async () => {
		const urls: string[] = [];
		const result = await verifyProviderConfig({
			baseUrl: "https://gw.example.com/v1",
			apiKey: "sk-12345678",
			modelId: "m1",
			fetchImpl: (async (url: string) => {
				urls.push(String(url));
				return json({}, 401);
			}) as unknown as typeof fetch,
		});
		expect(result).toMatchObject({ ok: false, step: "models" });
		expect(urls).toHaveLength(1); // 关键：没通就别再花钱
	});

	it("列表通了但协议不对（chat 404）→ step=chat", async () => {
		const result = await verifyProviderConfig({
			baseUrl: "https://gw.example.com/v1",
			api: "anthropic-messages",
			apiKey: "sk-12345678",
			modelId: "m1",
			fetchImpl: (async (url: string) =>
				String(url).endsWith("/models") ? json({ data: [] }) : json({}, 404)) as unknown as typeof fetch,
		});
		expect(result).toMatchObject({ ok: false, step: "chat" });
	});

	it("两步都通 → 给出两个耗时", async () => {
		const result = await verifyProviderConfig({
			baseUrl: "https://gw.example.com/v1",
			apiKey: "sk-12345678",
			modelId: "m1",
			fetchImpl: (async () => json({ data: [] })) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(typeof result.latencyMs).toBe("number");
			expect(typeof result.modelLatencyMs).toBe("number");
		}
	});

	it("没给 modelId 时只验证列表（不花钱）", async () => {
		let calls = 0;
		const result = await verifyProviderConfig({
			baseUrl: "https://gw.example.com/v1",
			apiKey: "sk-12345678",
			fetchImpl: (async () => {
				calls += 1;
				return json({ data: [] });
			}) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(1);
	});
});

describe("listRemoteModels：baseUrl 不带 /v1 的网关", () => {
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	it("/models 404 时回落到 /v1/models（nexita-anthropic 就是这种）", async () => {
		const urls: string[] = [];
		const result = await listRemoteModels({
			baseUrl: "https://codeapi.nexita.net",
			apiKey: "sk-12345678",
			fetchImpl: (async (url: string) => {
				urls.push(String(url));
				return String(url).endsWith("/v1/models") ? json({ data: [{ id: "deepseek-v4-pro" }] }) : json({}, 404);
			}) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
		expect(urls[0]).toBe("https://codeapi.nexita.net/models");
		expect(urls[1]).toBe("https://codeapi.nexita.net/v1/models");
	});

	it("第一个就通了就不再试第二个", async () => {
		let calls = 0;
		await listRemoteModels({
			baseUrl: "https://x.example.com/v1",
			apiKey: "sk-12345678",
			fetchImpl: (async () => {
				calls += 1;
				return json({ data: [] });
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
	});
});
