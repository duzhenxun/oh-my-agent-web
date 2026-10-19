/**
 * C 期：「填入模型信息」的解析 + 逐模型测试。
 * 解析要容错（models.dev 的结构不像官方文档那样稳定），测试要证明"不猜"。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractSpec } from "../../server/providers/catalog.js";
import { testModel } from "../../server/providers/model-test.js";

const sample = {
	deepseek: {
		models: {
			"deepseek-v4.1-flash": {
				name: "DeepSeek V4.1 Flash",
				reasoning: true,
				limit: { context: 1000000, output: 384000 },
				cost: { input: 0.14, output: 0.28, cache_read: 0.014 },
				modalities: { input: ["text", "image"] },
			},
			"deepseek-chat": { name: "DeepSeek Chat" },
		},
	},
};

describe("extractSpec（models.dev）", () => {
	it("按 id 取到规格、价格（含 cache_read 这种下划线写法）与能力", () => {
		expect(extractSpec(sample, "deepseek-v4.1-flash")).toEqual({
			name: "DeepSeek V4.1 Flash",
			contextWindow: 1000000,
			maxTokens: 384000,
			reasoning: true,
			imageInput: true,
			cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 },
		});
	});

	it("字段缺失就是 null —— 不猜", () => {
		const spec = extractSpec(sample, "deepseek-chat");
		expect(spec).toMatchObject({
			contextWindow: null,
			maxTokens: null,
			reasoning: false,
			imageInput: false,
			cost: null,
		});
	});

	it("找不到 / 垃圾输入都返回 null", () => {
		expect(extractSpec(sample, "不存在")).toBeNull();
		expect(extractSpec(null, "x")).toBeNull();
		expect(extractSpec({}, "x")).toBeNull();
	});
});

let server: Server;
let port = 0;

beforeAll(async () => {
	server = createServer((request, response) => {
		if (request.url === "/ok/chat/completions") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] }));
			return;
		}
		if (request.url === "/badkey/chat/completions") {
			response.writeHead(401).end("{}");
			return;
		}
		if (request.url === "/nomodel/chat/completions") {
			response.writeHead(404).end("{}");
			return;
		}
		response.writeHead(500).end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("testModel（会花钱的那一次请求）", () => {
	it("200 → 通，返回状态与耗时", async () => {
		const result = await testModel({ baseUrl: `http://127.0.0.1:${port}/ok`, apiKey: "sk-1234567890", modelId: "m1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe(200);
	});

	it("401 / 404 给出可操作提示，且不含 key", async () => {
		const unauthorized = await testModel({
			baseUrl: `http://127.0.0.1:${port}/badkey`,
			apiKey: "sk-super-secret-9",
			modelId: "m1",
		});
		expect(unauthorized.ok).toBe(false);
		if (!unauthorized.ok) {
			expect(unauthorized.message).toContain("key 可能不对");
			expect(unauthorized.message).not.toContain("sk-super-secret");
		}
		const missing = await testModel({
			baseUrl: `http://127.0.0.1:${port}/nomodel`,
			apiKey: "sk-1234567890",
			modelId: "m1",
		});
		if (!missing.ok) expect(missing.message).toContain("模型 id 或端点不对");
	});

	it("非 http(s) 直接拒", async () => {
		expect((await testModel({ baseUrl: "file:///etc", apiKey: "sk-1234567890", modelId: "m1" })).ok).toBe(false);
	});
});
