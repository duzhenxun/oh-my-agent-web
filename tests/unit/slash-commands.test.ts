/**
 * 斜杠面板的判定（`web/src/slash-commands.ts`）。
 *
 * 2026-11-24 用户把 7 条宿主命令删到只剩一条（`/new`）：
 * 「这些都删了吧，没啥用」→「把 /new 留着」。
 * 所以这里钉住两件事：
 *   1. 只有 `/new` 算「宿主动作」，其余 `/xxx` 一律当普通正文发出去（**不能被静默吞掉**）；
 *   2. `/skill ` 仍在挑技能、`/skill:具体名` 不弹面板（后者是正文，Enter 必须能直接发）。
 *
 * 历史 bug（这套用例的由来）：`Composer.submit` 曾用「首词是不是 agent 类命令」反推要不要继续发，
 * `/skill:smart-charts …` 两头都不匹配，于是既没执行也没发送 —— 点发送毫无反应。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterCommands, isAppCommand, parseSlashInput } from "../../web/src/slash-commands.ts";

describe("isAppCommand：宿主自己执行的命令", () => {
	it("只剩 /new（含带参数的）", () => {
		assert.equal(isAppCommand("/new"), true);
		assert.equal(isAppCommand("/new 第一条消息"), true);
		assert.equal(isAppCommand("  /NEW  x"), true, "大小写与多余空白不影响");
	});

	it("删掉的命令一律 false（要照常发给引擎，不能吞掉）", () => {
		for (const text of ["/name 新名字", "/model gpt", "/thinking high", "/copy", "/session", "/resume"]) {
			assert.equal(isAppCommand(text), false, text);
		}
	});

	it("引擎命令 / 技能 / 普通文本都是 false", () => {
		for (const text of ["/compact", "/plan on", "/skill:smart-charts 统计一下", "/wat", "你好", "", "  "]) {
			assert.equal(isAppCommand(text), false, text);
		}
	});
});

describe("filterCommands：一条宿主动作 + 三条发给引擎", () => {
	it("`/` 列出全部四条（new / skill / compact / plan）", () => {
		assert.deepEqual(
			filterCommands("").map((item) => item.name),
			["new", "skill", "compact", "plan"],
		);
	});

	it("前缀优先：`/n` 第一条是 new，`/pl` 只出 plan", () => {
		// 注意 `plan` 里也含 `n`（过滤是「前缀优先 + 包含兜底」），所以只断言第一条
		assert.equal(filterCommands("n")[0]?.name, "new");
		assert.deepEqual(
			filterCommands("pl").map((item) => item.name),
			["plan"],
		);
	});

	it("删掉的六条宿主命令不再出现", () => {
		for (const query of ["name", "model", "thinking", "copy", "session", "resume"]) {
			assert.equal(filterCommands(query).length, 0, query);
		}
	});

	it("三条 agent 命令标记为「发给 Agent」（不是本地执行）", () => {
		for (const name of ["skill", "compact", "plan"]) {
			const hit = filterCommands(name).find((item) => item.name === name);
			assert.equal(hit?.kind, "agent", name);
			assert.equal(isAppCommand(`/${name}`), false, `${name} 不能被宿主拦下`);
		}
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

	it("半截命令仍然弹命令面板（现在只有 new 可补全）", () => {
		assert.deepEqual(parseSlashInput("/n"), { mode: "commands", term: "n" });
		assert.deepEqual(parseSlashInput("/skill"), { mode: "commands", term: "skill" });
	});

	it("普通文本 / 已带空格的命令参数 → 不弹", () => {
		assert.equal(parseSlashInput("你好"), null);
		assert.equal(parseSlashInput("/new 第一条消息"), null);
	});
});
