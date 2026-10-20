/**
 * provider 的 API 协议与自定义 headers（回归：之前不管选什么协议，都只发 Bearer）。
 *
 * 这层的错误很隐蔽：配置看起来对、测试按钮也「通了」（有的网关两个头都认），
 * 但真到模型调用就被 401。所以协议 → 头的映射必须有测试钉住。
 */
import { describe, expect, it } from "vitest";
import { providerHeaders } from "../../server/providers/request-headers.js";
import { validateHeaders, validateProviderInput } from "../../server/providers/validate.js";

describe("providerHeaders：协议决定鉴权头", () => {
	it("anthropic-messages 用 x-api-key + anthropic-version", () => {
		const headers = providerHeaders("anthropic-messages", "sk-test");
		expect(headers["x-api-key"]).toBe("sk-test");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers.authorization).toBeUndefined();
	});

	it("其余协议用 Bearer", () => {
		for (const api of ["openai-completions", "openai-responses", "openai-codex-responses", "typesafe-system-one"]) {
			expect(providerHeaders(api, "sk-test").authorization).toBe("Bearer sk-test");
		}
	});

	it("自定义 header 可以覆盖默认（网关只认 x-api-key 时用得上）", () => {
		const headers = providerHeaders("openai-completions", "sk-test", { "x-api-key": "sk-test" });
		expect(headers["x-api-key"]).toBe("sk-test");
	});
});

describe("validateHeaders", () => {
	it("留空 = 不改动（undefined 而不是空对象）", () => {
		expect(validateHeaders(undefined)).toEqual({ ok: true, value: undefined });
	});

	it("去掉空行与空值", () => {
		const result = validateHeaders({ "X-Client": "agent-web", Empty: "  ", "": "x" });
		expect(result).toEqual({ ok: true, value: { "X-Client": "agent-web" } });
	});

	it("拒绝换行（CRLF 注入）与非法名称", () => {
		expect(validateHeaders({ "X-Bad": "a\r\nInjected: 1" }).ok).toBe(false);
		expect(validateHeaders({ "X Bad": "1" }).ok).toBe(false);
	});
});

describe("validateProviderInput：整个表单", () => {
	const base = { provider: "my-gw", baseUrl: "https://api.example.com/v1", apiKey: "sk-12345678" };

	it("带上 headers 后原样收进归一化结果", () => {
		const result = validateProviderInput({
			...base,
			api: "anthropic-messages",
			headers: { "X-A": "1" },
			models: ["m1"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.headers).toEqual({ "X-A": "1" });
			expect(result.value.api).toBe("anthropic-messages");
		}
	});

	it("api 不在白名单里就报错（避免写坏 models-store）", () => {
		const result = validateProviderInput({ ...base, api: "grpc", models: ["m1"] });
		expect(result.ok).toBe(false);
	});
});
