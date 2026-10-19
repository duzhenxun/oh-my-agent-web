/**
 * 连通性测试（B 期）：只打一次 GET /models。
 * 盯三件：成功后返回状态与耗时、失败信息**不含 key**、超时能及时返回。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeProvider } from "../../server/providers/probe.js";

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
