/**
 * 启动时的「要不要升级」询问（update-prompt.ts）。
 *
 * 交互本身没法在单测里敲键盘，所以把两个决策抽成了纯函数，守住这两件事：
 *   1. **只在真终端里问**：非 TTY / CI / 关掉开关 / 升完重启回来的那个进程都不问
 *      —— 问了也没人答，等于把启动卡在一个永远不会来的回车上；
 *   2. **回车 = 升级**，认不出的输入一律不升级（手滑打了个别的字符，不该替人装包）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnswer, shouldPromptUpgrade } from "../../server/update-prompt.ts";

const TTY = { stdinIsTTY: true, stdoutIsTTY: true, env: {} as Record<string, string | undefined> };

describe("要不要问升级", () => {
	it("真终端里问", () => {
		assert.equal(shouldPromptUpgrade(TTY), true);
	});

	it("非 TTY 不问（`aw > log`、被别的程序拉起）", () => {
		assert.equal(shouldPromptUpgrade({ ...TTY, stdoutIsTTY: false }), false);
		assert.equal(shouldPromptUpgrade({ ...TTY, stdinIsTTY: false }), false);
	});

	it("CI 里不问", () => {
		assert.equal(shouldPromptUpgrade({ ...TTY, env: { CI: "1" } }), false);
	});

	it("AGENT_WEB_UPDATE_PROMPT=off 不问（但检查还在，只是回到被动提示）", () => {
		for (const flag of ["off", "0", "false", "no", "OFF"]) {
			assert.equal(shouldPromptUpgrade({ ...TTY, env: { AGENT_WEB_UPDATE_PROMPT: flag } }), false, flag);
		}
		assert.equal(shouldPromptUpgrade({ ...TTY, env: { AGENT_WEB_UPDATE_PROMPT: "on" } }), true);
	});

	it("升完重启回来的进程不再问（否则问了又升、升了又问成环）", () => {
		assert.equal(shouldPromptUpgrade({ ...TTY, env: { AGENT_WEB_UPGRADE_REEXEC: "1" } }), false);
	});
});

describe("回答怎么读", () => {
	it("直接回车 = 升级", () => {
		assert.equal(parseAnswer(""), true);
		// 回车带进来的空白也算回车
		assert.equal(parseAnswer("   "), true);
	});

	it("y / yes / 是 都算同意", () => {
		for (const answer of ["y", "Y", "yes", "YES", "是", "好", "up"]) {
			assert.equal(parseAnswer(answer), true, answer);
		}
	});

	it("n / no / 不 算跳过", () => {
		for (const answer of ["n", "N", "no", "不", "否"]) {
			assert.equal(parseAnswer(answer), false, answer);
		}
	});

	it("认不出的输入不升级（手滑别替人装包）", () => {
		assert.equal(parseAnswer("asdf"), false);
		assert.equal(parseAnswer("maybe"), false);
	});

	it("Ctrl-C / EOF（null）不升级：人已经在急着启动了，别顺手改他的环境", () => {
		assert.equal(parseAnswer(null), false);
	});

	it("默认值可换：保守场景下回车也不升", () => {
		assert.equal(parseAnswer("", false), false);
	});
});
