/**
 * 模型分组（P6）：同一厂家归一组；不同厂家即使标签相同也必须分开
 * —— 这正是原生 select 做不到、用户抱怨「分不清点的是哪个」的根因。
 */
import { describe, expect, it } from "vitest";
import { groupModels, providerOf } from "../../web/src/model-groups.ts";

const models = [
	{ id: "nexita-anthropic/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
	{ id: "nexita-anthropic/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro 0813" },
	{ id: "nexita/gpt-5.6-luna", label: "GPT-5.6 Luna" },
	{ id: "nexita/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
	{ id: "cloudflare-aig/deepseek-flash", label: "DeepSeek Flash (Cloudflare AI Gateway)" },
	{ id: "no-slash-model", label: "无厂家" },
];

describe("providerOf", () => {
	it("取 id 的厂家段；没有斜杠归到 other", () => {
		expect(providerOf({ id: "nexita/x", label: "X" })).toBe("nexita");
		expect(providerOf({ id: "no-slash", label: "X" })).toBe("other");
	});
});

describe("groupModels", () => {
	it("按厂家分组，同厂家内保持原顺序", () => {
		const groups = groupModels(models);
		expect(groups.map((group) => group.provider)).toEqual(["nexita-anthropic", "nexita", "cloudflare-aig", "other"]);
		expect(groups[1]?.models.map((model) => model.label)).toEqual(["GPT-5.6 Luna", "DeepSeek V4.1 Flash"]);
	});

	it("标签相同的模型分在不同厂家的组里（不会混成一个）", () => {
		const groups = groupModels(models);
		const flash = groups.filter((group) => group.models.some((model) => model.label === "DeepSeek V4.1 Flash"));
		expect(flash.map((group) => group.provider)).toEqual(["nexita-anthropic", "nexita"]);
	});

	it("筛选：匹配标签或完整 id（含厂家名）", () => {
		expect(groupModels(models, "gpt").flatMap((group) => group.models)).toHaveLength(1);
		expect(groupModels(models, "cloudflare-aig")).toHaveLength(1);
		expect(groupModels(models, "deepseek-v4-pro")).toHaveLength(1);
		expect(groupModels(models, "不存在")).toEqual([]);
	});

	it("空白筛选等于不过滤", () => {
		expect(groupModels(models, "   ").length).toBe(groupModels(models).length);
	});
});
