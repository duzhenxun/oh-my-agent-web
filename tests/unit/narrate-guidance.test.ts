/**
 * 「动手前先说话」（见 narrate-guidance.ts）：用户看到的对话区里过程默认折叠，
 * 模型不写正文就只剩「1 段思考 1 次工具」—— 所以这段规则必须**每一轮都在**。
 *
 * 锁三件事：
 *   1. 头一句就是计划（先说要查/改什么、什么顺序），而不是复述需求或寒暄。
 *   2. 每个引擎的注入点都真的带上了它（pi 的 appendSystemPrompt、codex 的
 *      developerInstructions、dsh 的 patch 文本）—— 只写常量不接线等于没写。
 *   3. 保持短：这段每次请求都重复计费。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NARRATE_GUIDANCE } from "../../server/engine/narrate-guidance.ts";
import { dshSuggestionPatch } from "../../server/engine/dsh-prompt-patch.ts";
import { suggestionGuidance } from "../../server/engine/suggestion-guidance.ts";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("NARRATE_GUIDANCE", () => {
	it("头一句 = 先给计划，再思考/调工具", () => {
		assert.match(NARRATE_GUIDANCE, /Open with one plan sentence before thinking and before the first tool call/);
		assert.match(NARRATE_GUIDANCE, /no filler/);
	});

	it("保持短（每次请求都计费）", () => {
		assert.ok(NARRATE_GUIDANCE.length < 900, `too long: ${NARRATE_GUIDANCE.length}`);
	});
});

describe("注入点接线", () => {
	it("pi 的 appendSystemPrompt 里带着它", () => {
		assert.match(source("server/engine/pi-sdk.ts"), /NARRATE_GUIDANCE,/);
	});

	it("codex 的 developerInstructions 里带着它", () => {
		assert.match(source("server/engine/codex.ts"), /developerInstructions: \[\s*NARRATE_GUIDANCE,/);
	});

	it("dsh 的 patch 里带着它（跟建议写法一起塞进 personaSuffix）", () => {
		const yaml = dshSuggestionPatch([suggestionGuidance(4), NARRATE_GUIDANCE].join("\n\n"));
		assert.ok(yaml.includes("## Narrate before acting"));
		assert.ok(yaml.includes("## Suggested next actions"));
		assert.match(source("server/engine/wiring.ts"), /NARRATE_GUIDANCE\]\.join\("\\n\\n"\)/);
	});
});
