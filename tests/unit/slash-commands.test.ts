/**
 * 斜杠命令的「要不要发给引擎」判定（`web/src/slash-commands.ts`）。
 *
 * 用户报的 bug：在输入框打 `/skill:smart-charts 对当前项目统计一下`，点「发送」毫无反应。
 *
 * 根因：`Composer.submit` 用「首词是不是 `agent` 类命令」反推要不要继续发：
 *   `filterCommands("skill:smart-charts")` 在命令表里找不到（`skill` 那条的名字是 `skill`，
 *   不是 `skill:smart-charts`）→ `.some(kind === "agent")` 为 false → 直接 return。
 *   而 `runSlashCommand` 也不认识它（返回 handled:false），于是**两头都不做事**，消息凭空消失。
 *
 * 同时 `/skill:xxx` 还会被当成「正在敲命令」弹出面板，面板开着时 Enter 被面板吃掉，
 * 回车也发不出去。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAppCommand, parseSlashInput, runSlashCommand } from "../../web/src/slash-commands.ts";

describe("isAppCommand：宿主自己执行的命令", () => {
	it("app 类命令（含带参数的）都是 true", () => {
		for (const text of [
			"/new",
			"/new 第一条消息",
			"/name 新名字",
			"/model gpt",
			"/copy",
			"/session",
			"/resume",
			"/thinking high",
		]) {
			assert.equal(isAppCommand(text), true, text);
		}
	});

	it("交给引擎的命令是 false（要照常发出去）", () => {
		for (const text of ["/compact", "/plan on", "/cwd /tmp", "/skill:smart-charts 对当前项目统计一下"]) {
			assert.equal(isAppCommand(text), false, text);
		}
	});

	it("不认识的命令 / 普通文本也是 false（照常发出去，别静默吞掉）", () => {
		for (const text of ["/wat", "/skill:unknown-skill", "你好", "", "  "]) {
			assert.equal(isAppCommand(text), false, text);
		}
	});

	it("大小写与多余空白不影响判定", () => {
		assert.equal(isAppCommand("  /NEW  x"), true);
		assert.equal(isAppCommand("/skill:Smart-Charts x"), false);
	});
});

describe("parseSlashInput：什么时候弹面板", () => {
	it("`/skill:具体名字` 不弹面板（那是发给引擎的正文，Enter 要能直接发）", () => {
		assert.equal(parseSlashInput("/skill:smart-charts"), null);
		assert.equal(parseSlashInput("/skill:smart-charts 对当前项目统计一下"), null);
	});

	it("`/skill ` 之后仍在挑技能（弹技能面板）", () => {
		assert.deepEqual(parseSlashInput("/skill "), { mode: "skills", term: "" });
		assert.deepEqual(parseSlashInput("/skill smart"), { mode: "skills", term: "smart" });
	});

	it("半截命令仍然弹命令面板", () => {
		assert.deepEqual(parseSlashInput("/na"), { mode: "commands", term: "na" });
		assert.deepEqual(parseSlashInput("/skill"), { mode: "commands", term: "skill" });
	});

	it("普通文本 / 已带空格的命令参数 → 不弹", () => {
		assert.equal(parseSlashInput("你好"), null);
		assert.equal(parseSlashInput("/name 新名字"), null);
	});
});

describe("runSlashCommand：认识的和不认识的", () => {
	it("`/skill:xxx …` 不会被宿主当成命令执行（handled:false = 交给引擎）", async () => {
		const outcome = await runSlashCommand("/skill:smart-charts 对当前项目统计一下", null);
		assert.deepEqual(outcome, { handled: false });
	});

	it("`/resume` 这类 app 命令不交出去", async () => {
		const outcome = await runSlashCommand("/resume", null);
		assert.deepEqual(outcome, { handled: true });
	});
});
