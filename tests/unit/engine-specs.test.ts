/**
 * 第三方引擎的文案（`server/engine/engine-specs.ts`，ADR-0052）。
 *
 * 这里守的是一条产品边界：**工作台不装引擎、不动用户环境**。
 * 所以断言的重点不是措辞好看，而是：
 *   - 不能出现「你去装全局包」这类指令（以前就是 `npm i -g`，装在 App 里等于死路）；
 *   - 必须说清「我们不装」+「你自己装好就能用」+「或者用逃生阀变量指过去」。
 *
 * 另外四个引擎的错误映射都会走到这里（codex / dsh / opencode / claude），
 * 漏一个就是某一档「找不到」回到原始 ENOENT 报错。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENGINE_KEYS, ENGINE_SPECS, isEngineKey, missingEngineMessage } from "../../server/engine/engine-specs.js";

describe("ENGINE_SPECS", () => {
	it("四个第三方引擎都在（pi 是自带的，不在这里）", () => {
		assert.deepEqual(ENGINE_KEYS, ["codex", "dsh", "opencode", "claude"]);
		for (const key of ENGINE_KEYS) {
			assert.ok(ENGINE_SPECS[key].bins.length > 0, `${key} 至少要认一个命令名`);
			assert.ok(ENGINE_SPECS[key].binEnv.startsWith("AGENT_WEB_"), `${key} 的逃生阀变量名`);
		}
	});

	it("claude 的适配器改过名：两个命令名都要认", () => {
		assert.deepEqual(ENGINE_SPECS.claude.bins, ["claude-code-acp", "claude-agent-acp"]);
	});
});

describe("isEngineKey", () => {
	it("只认已知的四个（拼错了要能拒掉，别装成别的东西）", () => {
		assert.equal(isEngineKey("codex"), true);
		assert.equal(isEngineKey("claude"), true);
		assert.equal(isEngineKey("pi"), false);
		assert.equal(isEngineKey("Codex"), false);
	});
});

describe("missingEngineMessage", () => {
	it("每个引擎都给出「界面上可以点安装」+ 逃生阀变量", () => {
		for (const key of ENGINE_KEYS) {
			const message = missingEngineMessage(key);
			assert.match(message, /在引擎切换面板里点「安装」/, key);
			assert.match(message, /不碰系统、不用 sudo/, key);
			assert.match(message, new RegExp(ENGINE_SPECS[key].binEnv), `${key} 要给出逃生阀变量`);
		}
	});

	it("引导是给用户的：界面上点按钮，或自己动手", () => {
		for (const key of ENGINE_KEYS) {
			assert.match(missingEngineMessage(key), /也可以你自己装：/, key);
		}
	});

	it("codex / opencode / claude 给出具体可执行的引导", () => {
		assert.match(missingEngineMessage("codex"), /也可以你自己装：npm i -g @openai\/codex/);
		assert.match(missingEngineMessage("opencode"), /也可以你自己装：npm i -g opencode-ai/);
		assert.match(missingEngineMessage("claude"), /也可以你自己装：npm i -g @agentclientprotocol\/claude-agent-acp/);
		// 旧名也留着：搜老包的人才找得到
		assert.match(missingEngineMessage("claude"), /@zed-industries\/claude-code-acp/);
	});

	it("dsh 没有公开 npm 包：如实说，不编一个包名让人装错东西", () => {
		const message = missingEngineMessage("dsh");
		assert.match(message, /没有公开的 npm 包/);
		assert.doesNotMatch(message, /npm i -g/, "dsh 不该指到某个 npm 包");
	});

	it("claude 额外提醒本体要另装并登录（光有适配器跑不起来）", () => {
		assert.match(missingEngineMessage("claude"), /Claude Code 本体.*登录/);
	});

	it("指出了首选的命令名，人一眼知道该在 PATH 里出现什么", () => {
		assert.match(missingEngineMessage("codex"), /PATH 里能找到 codex/);
		assert.match(missingEngineMessage("claude"), /PATH 里能找到 claude-code-acp/);
	});
});
