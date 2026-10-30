/**
 * 「工具名 + 参数 → 图标 + 一句人话」（`web/src/components/tool-activity.tsx`）。
 *
 * 这一层是**给人看的**：实时行（`正在读取 X 技能`）和跑完的步骤清单（`已读取 x.py`）都用它，
 * 所以这里锁三件事：
 *   1. 读 `skills/<slug>/SKILL.md` 要说成「技能」，不能露出路径和 `SKILL.md`（用户 2026-10-30 的原话就是
 *      「换小图标告知现在是在调工具还是调 skill」）；
 *   2. bash 跑 `ls` 是「列目录」，不是「跑命令」—— 图标跟着动作走，不跟着工具名走；
 *   3. 参数摘要**被截断过**是常态（引擎按字数截），这时 JSON parse 不出来，仍要把命令抠出来；
 *      认不出的工具（MCP）不能炸，退到 `other` 照样有一行。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTool } from "../../web/src/components/tool-activity.tsx";

describe("describeTool", () => {
	it("读 SKILL.md = 加载技能（说技能名，不是路径）", () => {
		const info = describeTool("read", '{"path":"/Users/dds/.agents/skills/weather-forecast/SKILL.md"}');
		assert.equal(info.kind, "skill");
		assert.equal(info.now, "正在读取 Weather Forecast 技能");
		assert.equal(info.done, "已读取 Weather Forecast 技能");
		assert.equal(info.detail, null); // 路径不再重复一遍
	});

	it("普通文件 = 读文件（只给文件名）", () => {
		const info = describeTool("read", '{"path":"/repo/web/src/components/ToolCard.tsx"}');
		assert.equal(info.kind, "read");
		assert.equal(info.done, "已读取 ToolCard.tsx");
	});

	it("bash 里的 ls 是列目录", () => {
		const info = describeTool("bash", '{"command":"ls /tmp/new-skill-3"}');
		assert.equal(info.kind, "list");
		assert.equal(info.done, "已列出 new-skill-3");
	});

	it("带 --flag 的 ls 仍然认得出目标目录", () => {
		const info = describeTool("bash", '{"command":"ls -la /repo/server"}');
		assert.equal(info.kind, "list");
		assert.equal(info.now, "正在列出 server");
	});

	it("跑命令：抬头说「在干什么事」（git status = 看改动状态），命令挂在行尾", () => {
		const info = describeTool("bash", '{"command":"git status --short"}');
		assert.equal(info.kind, "run");
		assert.equal(info.now, "正在看改动状态");
		assert.equal(info.detail, "git status --short");
	});

	it("跑脚本（heredoc）：说「Python 脚本」并把脚本正文摆出来，而不是半截 `<<'PY'`", () => {
		const info = describeTool(
			"bash",
			'{"command":"cd /tmp && python3 - <<\'PY\'\\nimport json,urllib.request\\nurl = \\"https://wttr.in/qingdao?format=j1\\""}',
		);
		assert.equal(info.kind, "run");
		assert.equal(info.now, "正在跑 Python 脚本");
		// 行尾只留开头一截（脚本永远显示不全，全文交给 `full`）
		assert.match(info.detail ?? "", /^import json,urllib\.request/);
		assert.ok((info.detail ?? "").length <= 49, `detail 太长：${info.detail}`);
		assert.match(info.full ?? "", /wttr\.in\/qingdao\?format=j1/);
	});

	it("curl 拉远程地址 = 联网抓取（不是“运行 curl”）", () => {
		const info = describeTool("bash", '{"command":"curl -sS --max-time 20 https://wttr.in/Beijing?format=j1"}');
		assert.equal(info.kind, "web");
		assert.equal(info.now, "正在抓取 wttr.in");
		assert.equal(info.detail, "https://wttr.in/Beijing?format=j1");
	});

	it("`cd x && curl …` 也算联网抓取", () => {
		const info = describeTool("bash", '{"command":"cd /tmp && curl -s https://example.com/a.json"}');
		assert.equal(info.kind, "web");
		assert.equal(info.now, "正在抓取 example.com");
	});

	it("摘要被截断（JSON 不完整）也要把命令抠出来，且还原 \\u0026", () => {
		const info = describeTool("bash", '{"command":"cd /tmp \\u0026\\u0026 cat > w.py <<\'E');
		assert.equal(info.kind, "run");
		assert.equal(info.detail, "cd /tmp && cat > w.py <<'E");
	});

	it("检索 / 联网 / 改文件 / 子代理 各自的图标种类", () => {
		assert.equal(describeTool("grep", '{"pattern":"msg-activity"}').kind, "search");
		assert.equal(describeTool("web_search", '{"queries":["北京天气","wttr.in"]}').detail, "北京天气");
		assert.equal(describeTool("web_search", '{"queries":["北京天气"]}').kind, "web");
		assert.equal(describeTool("edit", '{"path":"/repo/web/src/styles/chat.css"}').done, "已修改 chat.css");
		const agent = describeTool("Agent", '{"description":"看 codex 实时行","subagent_type":"explore"}');
		assert.equal(agent.kind, "agent");
		assert.equal(agent.detail, "看 codex 实时行");
	});

	it("认不出来的工具（MCP / 新引擎）不炸，原样报名字", () => {
		const info = describeTool("mcp__foo__bar", '{"x":1}');
		assert.equal(info.kind, "other");
		assert.equal(info.done, "已执行 mcp__foo__bar");
	});

	it("参数为空也不会崩（拿不到就说「正在读取文件」这种）", () => {
		const info = describeTool("read", "");
		assert.equal(info.kind, "read");
		assert.equal(info.now, "正在读取文件");
		assert.equal(info.detail, null);
	});
});

/**
 * 用户 2026-10-30 的两句原话：
 *   - 「你的脚本显示不全就别显示这么长，你把正在干什么给我写清楚了」
 *   - 「需要有个可以点开，我想点开看的时候，可以点开看一眼到底在干嘛」
 * 对应到这一层：行尾（`detail`）压短一句能扫完的，全文放 `full` 交给弹层。
 */
describe("脚本类命令：行尾压短、全文留给弹层", () => {
	it("`node -e '…'` 说「正在跑 Node 脚本」，不再把整条命令糊在行尾", () => {
		const code = 'const fs=require("fs"); console.log(fs.readdirSync("docs/screenshots").length)';
		const info = describeTool("bash", JSON.stringify({ command: `node -e '${code}'` }));
		assert.equal(info.kind, "run");
		assert.equal(info.now, "正在跑 Node 脚本");
		// 行尾是压短过的：能扫一眼，不会长到占满一行
		assert.ok((info.detail ?? "").length <= 65, `detail 太长：${info.detail}`);
		assert.match(info.detail ?? "", /^const fs=require/);
		// 全文一个字不少（弹层里看）
		assert.equal(info.full, code);
	});

	it("`node --import tsx -e '…'` 中间夹着带值的 flag 也认得出", () => {
		const info = describeTool(
			"bash",
			JSON.stringify({ command: `node --import tsx -e 'import {NARRATE_GUIDANCE} from "./x.ts"; console.log(1)'` }),
		);
		assert.equal(info.now, "正在跑 Node 脚本");
		assert.match(info.full ?? "", /NARRATE_GUIDANCE/);
	});

	it("`python3 -c '…'` 也算脚本（不只是 heredoc）", () => {
		const info = describeTool("bash", JSON.stringify({ command: `python3 -c 'print("hi")'` }));
		assert.equal(info.now, "正在跑 Python 脚本");
		assert.equal(info.full, 'print("hi")');
	});

	it("长命令的行尾一律压到 64 字以内，全文照旧留好", () => {
		const command = `git commit -m "${"很长的提交说明".repeat(20)}"`;
		const info = describeTool("bash", JSON.stringify({ command }));
		assert.ok((info.detail ?? "").length <= 65, `detail 太长：${info.detail}`);
		assert.equal(info.full, command);
	});

	it("读文件 / 技能这种没有「更多可看」的，full 为 null（不给一个点不开的按钮）", () => {
		assert.equal(describeTool("read", '{"path":"/repo/a.md"}').full, null);
		assert.equal(describeTool("read", '{"path":"/repo/skills/weather-forecast/SKILL.md"}').full, null);
	});
});
