/**
 * 定时任务「AI 生成任务描述」的纯逻辑：请求拼装与生成器分支（不依赖真实模型）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildCronPromptRequest,
	CRON_PROMPT_SYSTEM,
	createCronPromptGenerator,
} from "../../server/session/cron-prompt.js";

describe("buildCronPromptRequest", () => {
	it("把标题放进请求里", () => {
		assert.match(buildCronPromptRequest("每日检查磁盘"), /任务标题：每日检查磁盘/);
	});
});

describe("createCronPromptGenerator", () => {
	it("空标题（或非字符串）直接拒绝，不调用模型", async () => {
		let called = false;
		const generate = createCronPromptGenerator({
			ask: async () => {
				called = true;
				return "x";
			},
		});
		for (const name of ["", "   ", undefined, 42]) {
			const result = await generate(name);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.code, "cron.empty");
		}
		assert.equal(called, false);
	});

	it("把标题与系统提示词交给 ask，并清洗前导语与代码围栏", async () => {
		let seenPrompt = "";
		let seenSystem = "";
		let seenConversation: string | null = "unset";
		const generate = createCronPromptGenerator({
			ask: async (prompt, system, conversationId) => {
				seenPrompt = prompt;
				seenSystem = system;
				seenConversation = conversationId;
				return "好的，以下是任务描述：\n检查 CI 失败的分支并汇总原因。";
			},
		});
		const result = await generate("  检查 CI  ", "conv-1");
		assert.deepEqual(result, { ok: true, text: "检查 CI 失败的分支并汇总原因。" });
		assert.match(seenPrompt, /任务标题：检查 CI/);
		assert.equal(seenSystem, CRON_PROMPT_SYSTEM);
		assert.equal(seenConversation, "conv-1");
	});

	it("ask 返回 null（没有可用模型）给出专用错误码", async () => {
		const generate = createCronPromptGenerator({ ask: async () => null });
		const result = await generate("每日检查");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "cron.no_model");
	});

	it("ask 抛错转成 cron.failed，不向外抛异常", async () => {
		const generate = createCronPromptGenerator({
			ask: async () => {
				throw new Error("上游超时");
			},
		});
		const result = await generate("每日检查");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error.code, "cron.failed");
			assert.match(result.error.message, /上游超时/);
		}
	});

	it("模型只回了前导语或空白时报 cron.empty_output", async () => {
		const generate = createCronPromptGenerator({ ask: async () => "   \n  " });
		const result = await generate("每日检查");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "cron.empty_output");
	});
});
