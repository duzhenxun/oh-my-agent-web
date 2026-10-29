/**
 * 「下一步建议」的写法（ADR-0022）：条数必须跟设置里「想想」的那个数一致。
 *
 * 锁两件事：
 *   1. `suggestionGuidance(n)` 的条数跟着设置走（pi / codex 都在建会话时现读它写进系统提示）；
 *      拿不到设置（undefined / 越界 / 非整数）才退回默认 4~5 条。
 *   2. dsh 的 patch 文件里**必须同时带上 personaPrefix**：dsh 的 `config` 是整块替换而不是深合并，
 *      只写 personaSuffix 会把 acp 模板那句 persona 冲掉（实测 dump 里会整个消失）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dshSuggestionPatch } from "../../server/engine/dsh-prompt-patch.ts";
import { SUGGESTION_GUIDANCE, suggestionGuidance } from "../../server/engine/suggestion-guidance.ts";

describe("suggestionGuidance", () => {
	it("条数跟设置走（3 条就写 3 条）", () => {
		assert.match(suggestionGuidance(3), /end the reply with 3 lines of:/);
		assert.match(suggestionGuidance(1), /end the reply with 1 line of:/);
		assert.match(suggestionGuidance(5), /end the reply with 5 lines of:/);
	});

	it("拿不到/越界的条数退回默认 4~5 条", () => {
		for (const value of [undefined, null, 0, 6, 2.5]) {
			assert.match(suggestionGuidance(value), /end the reply with 4 to 5 lines of:/);
		}
	});

	it("标记语法本身不变（服务端解析器只认这几种写法）", () => {
		const text = suggestionGuidance(4);
		assert.ok(text.includes("[[action:suggest:<button text>]]"));
		assert.ok(text.includes("prompt=<text to send>"));
		assert.equal(SUGGESTION_GUIDANCE, suggestionGuidance());
	});
});

describe("dshSuggestionPatch", () => {
	it("同时带上 personaPrefix 与 personaSuffix（整块替换，不写就丢）", () => {
		const yaml = dshSuggestionPatch(suggestionGuidance(4));
		assert.ok(yaml.includes("personaPrefix: |"));
		assert.ok(yaml.includes("You are a coding agent powered by the {{model}} model."));
		assert.ok(yaml.includes("personaSuffix: |"));
		assert.ok(yaml.includes("Your working directory is {{cwd}}."));
		// 目标插件 id 写错 = patch 静默不生效，所以钉住它
		assert.ok(yaml.includes("- id: system-prompt"));
	});

	it("建议说明按块标量缩进进 personaSuffix（每行都带缩进，YAML 不会塌成一行）", () => {
		const guidance = suggestionGuidance(3);
		const yaml = dshSuggestionPatch(guidance);
		const suffixPart = yaml.slice(yaml.indexOf("personaSuffix: |"));
		for (const line of guidance.split("\n")) {
			assert.ok(suffixPart.includes(`      ${line}`), `缺少缩进行：${line}`);
		}
	});
});
