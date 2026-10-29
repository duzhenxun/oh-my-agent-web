/**
 * 非 pi 引擎「模型」面板的左栏分组（`web/src/engine-model-groups.ts`）。
 *
 * 分组口径要钉住的原因：三个引擎给的模型 id 形状完全不同 ——
 *   claude 统一成 `anthropic/<modelId>`、opencode / dsh 是 `provider/model`、codex 是裸 slug。
 * 这里错一个字符，面板左栏就会冒出 `provider/` 这样的空组，或者把 codex 的模型塞进 "other"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupEngineModels, modelProviderOf, modelShortLabel } from "../../web/src/engine-model-groups.ts";

describe("modelProviderOf", () => {
	it("取第一段斜杠之前的部分", () => {
		assert.equal(modelProviderOf("anthropic/opus"), "anthropic");
		assert.equal(modelProviderOf("deepseek-account/deepseek-flash"), "deepseek-account");
	});

	it("裸 slug / 首尾斜杠都不算 provider（codex 就是裸 slug）", () => {
		assert.equal(modelProviderOf("deepseek-flash"), null);
		assert.equal(modelProviderOf("/opus"), null);
		assert.equal(modelProviderOf("anthropic/"), null);
		assert.equal(modelProviderOf(""), null);
	});
});

describe("modelShortLabel", () => {
	it("label 等于 id 时去掉 provider 前缀", () => {
		assert.equal(modelShortLabel({ id: "anthropic/opus", label: "anthropic/opus" }), "opus");
	});

	it("引擎给了人看的 label 就原样用（别把人写好的名字改坏）", () => {
		assert.equal(modelShortLabel({ id: "anthropic/opus", label: "Opus" }), "Opus");
	});

	it("裸 slug 原样（codex 的 label 就是 slug）", () => {
		assert.equal(modelShortLabel({ id: "deepseek-flash", label: "deepseek-flash" }), "deepseek-flash");
	});
});

describe("groupEngineModels", () => {
	it("provider/model 口径按前缀分组，且保持引擎给的顺序", () => {
		const groups = groupEngineModels(
			[
				{ id: "anthropic/opus", label: "anthropic/opus" },
				{ id: "anthropic/haiku", label: "anthropic/haiku" },
				{ id: "openai/gpt-5", label: "openai/gpt-5" },
			],
			{ name: "claude", label: "Claude Code" },
		);
		assert.deepEqual(
			groups.map((group) => [group.id, group.models.map((model) => model.id)]),
			[
				["anthropic", ["anthropic/opus", "anthropic/haiku"]],
				["openai", ["openai/gpt-5"]],
			],
		);
	});

	it("裸 slug 全部落在「引擎自己」这一组（不编假的 provider 名）", () => {
		const groups = groupEngineModels(
			[
				{ id: "deepseek-flash", label: "deepseek-flash" },
				{ id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
			],
			{ name: "codex", label: "Codex" },
		);
		assert.equal(groups.length, 1);
		assert.equal(groups[0]?.id, "codex");
		assert.equal(groups[0]?.label, "Codex");
		assert.equal(groups[0]?.models.length, 2);
	});

	it("混合口径：有前缀的照前缀分，没有的归引擎那组（互不吞并）", () => {
		const groups = groupEngineModels(
			[
				{ id: "nexita/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
				{ id: "gpt-5", label: "gpt-5" },
			],
			{ name: "codex", label: "Codex" },
		);
		assert.deepEqual(
			groups.map((group) => group.id),
			["nexita", "codex"],
		);
	});

	it("空清单不炸（模型表要开会话才有，启动时是空的）", () => {
		assert.deepEqual(groupEngineModels([], { name: "claude", label: "Claude Code" }), []);
	});
});
