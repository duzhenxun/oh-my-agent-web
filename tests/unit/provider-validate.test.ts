/**
 * provider 配置校验（ADR-0025 §3）：这些都是「写进 pi 配置文件」的值，
 * 校验漏一个，代价是下次 pi 启动整个模型表读不出来。
 */
import { describe, expect, it } from "vitest";
import { maskKey, validateApiKey, validateBaseUrl, validateProviderInput } from "../../server/providers/validate.js";

describe("validateBaseUrl", () => {
	it("http(s) 通过，去掉尾部斜杠", () => {
		expect(validateBaseUrl("https://api.deepseek.com/")).toEqual({ ok: true, value: "https://api.deepseek.com" });
		expect(validateBaseUrl("http://127.0.0.1:8080").ok).toBe(true);
	});

	it("拒绝非 http(s) 与把凭证塞进地址", () => {
		expect(validateBaseUrl("file:///etc/passwd").ok).toBe(false);
		expect(validateBaseUrl("javascript:alert(1)").ok).toBe(false);
		expect(validateBaseUrl("https://user:pass@api.example.com").ok).toBe(false);
		expect(validateBaseUrl("不是 url").ok).toBe(false);
		expect(validateBaseUrl("").ok).toBe(false);
	});
});

describe("validateApiKey", () => {
	it("留空 = 不修改（undefined，不是错误）", () => {
		expect(validateApiKey("")).toEqual({ ok: true, value: undefined });
		expect(validateApiKey(undefined)).toEqual({ ok: true, value: undefined });
	});

	it("长度与换行", () => {
		expect(validateApiKey("short").ok).toBe(false);
		expect(validateApiKey("sk-1234567890").ok).toBe(true);
		expect(validateApiKey("sk-1234567890\nrm -rf").ok).toBe(false);
	});
});

describe("maskKey", () => {
	it("只暴露尾 4 位", () => {
		expect(maskKey("sk-abcdefgh1234")).toBe("…1234");
		expect(maskKey(undefined)).toBeNull();
	});
});

describe("validateProviderInput", () => {
	const good = {
		provider: "my-endpoint",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-1234567890",
		models: [{ id: "gpt-x" }, { id: "gpt-y", name: "GPT Y" }],
	};

	it("合法输入归一化（provider 小写、模型去重、默认 api）", () => {
		const result = validateProviderInput({ ...good, provider: "My-Endpoint", models: ["gpt-x", "gpt-x", "gpt-y"] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.provider).toBe("my-endpoint");
		expect(result.value.api).toBe("openai-completions");
		expect(result.value.models.map((model) => model.id)).toEqual(["gpt-x", "gpt-y"]);
	});

	it("一次收集所有错误（不让用户挤牙膏）", () => {
		const result = validateProviderInput({ provider: "BAD ID", baseUrl: "ftp://x", models: [] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.length).toBeGreaterThanOrEqual(3);
	});

	it("没有模型 / 模型 id 含非法字符都被拒", () => {
		expect(validateProviderInput({ ...good, models: [] }).ok).toBe(false);
		expect(validateProviderInput({ ...good, models: ["有 空格"] }).ok).toBe(false);
	});

	it("api 必须是白名单里的形态", () => {
		expect(validateProviderInput({ ...good, api: "随便写的" }).ok).toBe(false);
		expect(validateProviderInput({ ...good, api: "anthropic-messages" }).ok).toBe(true);
	});
});

describe("validateModelSpec（ADR-0026 A 期）", () => {
	const good = {
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		imageInput: true,
		contextWindow: "1000000",
		maxTokens: "384000",
		cost: { input: "0.1", output: "0.2" },
	};

	it("规格与能力归一化，价格留空当 0", async () => {
		const { validateModelSpec } = await import("../../server/providers/validate.js");
		const result = validateModelSpec(good);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			id: "deepseek-v4.1-flash",
			reasoning: true,
			imageInput: true,
			contextWindow: 1000000,
			maxTokens: 384000,
		});
		expect(result.value.cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 });
	});

	it("价格全空 → cost = null（界面显示「未提供」而不是 0）", async () => {
		const { validateModelSpec } = await import("../../server/providers/validate.js");
		const result = validateModelSpec({ id: "m", name: "M", cost: {} });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cost).toBeNull();
	});

	it("上下文窗口 / 最大输出必须是正整数", async () => {
		const { validateModelSpec } = await import("../../server/providers/validate.js");
		expect(validateModelSpec({ ...good, contextWindow: "-5" }).ok).toBe(false);
		expect(validateModelSpec({ ...good, maxTokens: "abc" }).ok).toBe(false);
		expect(validateModelSpec({ ...good, contextWindow: "999999999999" }).ok).toBe(false);
	});

	it("价格为负 → 拒绝", async () => {
		const { validateModelSpec } = await import("../../server/providers/validate.js");
		expect(validateModelSpec({ ...good, cost: { input: "-1" } }).ok).toBe(false);
	});

	it("id 含非法字符 → 拒绝", async () => {
		const { validateModelSpec } = await import("../../server/providers/validate.js");
		expect(validateModelSpec({ ...good, id: "有 空格" }).ok).toBe(false);
	});
});
