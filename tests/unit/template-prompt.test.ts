/**
 * 「AI 生成提示词」的纯逻辑：输入规整、拼提示词、输出清洗、生成器分支。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildTemplatePromptRequest,
	createTemplatePromptGenerator,
	normalizeTemplatePromptInput,
	sanitizeTemplatePrompt,
	TEMPLATE_PROMPT_SYSTEM,
} from "../../server/session/template-prompt.js";

describe("normalizeTemplatePromptInput", () => {
	it("去空白、忽略非字符串", () => {
		assert.deepEqual(normalizeTemplatePromptInput({ name: "  代码审查 ", description: 3, text: undefined }), {
			name: "代码审查",
			description: "",
			text: "",
		});
	});

	it("超长按字符截断（中文不会切出半个字）", () => {
		const long = "审".repeat(10_000);
		const out = normalizeTemplatePromptInput({ text: long });
		assert.equal([...out.text].length, 6000);
	});
});

describe("buildTemplatePromptRequest", () => {
	it("有草稿时明确要求在草稿基础上改写", () => {
		const prompt = buildTemplatePromptRequest({ name: "代码审查", description: "对照规格", text: "看看 diff" });
		assert.match(prompt, /标题：代码审查/);
		assert.match(prompt, /说明：对照规格/);
		assert.match(prompt, /已有草稿/);
		assert.match(prompt, /看看 diff/);
	});

	it("没有草稿时只依赖标题和说明", () => {
		const prompt = buildTemplatePromptRequest({ name: "仓库初始化", description: "", text: "" });
		assert.match(prompt, /标题：仓库初始化/);
		assert.doesNotMatch(prompt, /说明：/);
		assert.match(prompt, /还没有草稿/);
	});

	it("系统提示词要求的是标准结构，而不是起名", () => {
		assert.match(TEMPLATE_PROMPT_SYSTEM, /目标/);
		assert.match(TEMPLATE_PROMPT_SYSTEM, /输出/);
		assert.match(TEMPLATE_PROMPT_SYSTEM, /约束/);
	});
});

describe("sanitizeTemplatePrompt", () => {
	it("去掉代码块围栏", () => {
		assert.equal(sanitizeTemplatePrompt("```markdown\n1. 目标：审查\n```"), "1. 目标：审查");
	});

	it("去掉「好的，以下是…：」这类前导语", () => {
		assert.equal(sanitizeTemplatePrompt("好的，以下是标准提示词：\n审查当前改动。"), "审查当前改动。");
	});

	it("正文第一行不是前导语时原样保留", () => {
		assert.equal(
			sanitizeTemplatePrompt("审查当前改动：对照规格。\n按严重程度排序。"),
			"审查当前改动：对照规格。\n按严重程度排序。",
		);
	});
});

describe("createTemplatePromptGenerator", () => {
	it("标题、说明、草稿全空 → 直接报错，不调模型", async () => {
		let called = false;
		const generate = createTemplatePromptGenerator({
			ask: async () => {
				called = true;
				return "x";
			},
		});
		const result = await generate({ name: " ", description: "", text: "" });
		assert.equal(result.ok, false);
		assert.equal(called, false);
	});

	it("正常路径：把拼好的提示词和系统提示词交给 ask，返回清洗后的正文", async () => {
		let seen: { prompt: string; system: string } | null = null;
		const generate = createTemplatePromptGenerator({
			ask: async (prompt, system) => {
				seen = { prompt, system };
				return "好的，以下是：\n1. 目标：审查改动";
			},
		});
		const result = await generate({ name: "代码审查", description: "", text: "" });
		assert.deepEqual(result, { ok: true, text: "1. 目标：审查改动" });
		assert.ok(seen);
		assert.match((seen as { prompt: string }).prompt, /标题：代码审查/);
		assert.equal((seen as { system: string }).system, TEMPLATE_PROMPT_SYSTEM);
	});

	it("ask 返回 null（没有可用模型）→ 给出模型相关的文案", async () => {
		const generate = createTemplatePromptGenerator({ ask: async () => null });
		const result = await generate({ name: "x", description: "", text: "" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "template.no_model");
	});

	it("ask 抛错 → 带上原因，不向外抛", async () => {
		const generate = createTemplatePromptGenerator({
			ask: async () => {
				throw new Error("上游 503");
			},
		});
		const result = await generate({ name: "x", description: "", text: "" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error.message, /上游 503/);
	});

	it("模型只回了前导语、清洗后为空 → 提示重试", async () => {
		const generate = createTemplatePromptGenerator({ ask: async () => "```\n```" });
		const result = await generate({ name: "x", description: "", text: "" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "template.empty_output");
	});
});
