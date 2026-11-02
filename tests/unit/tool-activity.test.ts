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
		// 行尾从脚本正文开头摆起（不是半截 `<<'PY'`），长度只受宽松上限管制，露几字看宽度
		assert.match(info.detail ?? "", /^import json,urllib\.request/);
		assert.ok((info.detail ?? "").length <= 121, `detail 太长：${info.detail}`);
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
 * 行尾（`detail`）与全文（`full`）的分工。
 *
 * 历史：2026-10-30 曾把行尾压到 64 字（当时抱怨「脚本显示不全就别显示这么长」）；
 * 2026-11-02 用户改口「太短了，应按宽度显示到能显示的位置」——固定字数截断会在还有余量时
 * 提前断掉。现在行尾只留一个**宽松上限**（命令 200 / 脚本 120），真正决定看到几字的是 CSS
 * 省略号；全文照旧一个字不少地放在 `full` 里，点开弹层看。
 */
describe("脚本类命令：行尾压短、全文留给弹层", () => {
	it("`node -e '…'` 说「正在跑 Node 脚本」，不再把整条命令糊在行尾", () => {
		const code = 'const fs=require("fs"); console.log(fs.readdirSync("docs/screenshots").length)';
		const info = describeTool("bash", JSON.stringify({ command: `node -e '${code}'` }));
		assert.equal(info.kind, "run");
		assert.equal(info.now, "正在跑 Node 脚本");
		// 行尾只是「截到一个宽松上限」，具体露几字由 CSS 省略号按宽度决定
		assert.ok((info.detail ?? "").length <= 121, `detail 太长：${info.detail}`);
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

	it("超长命令只截到宽松上限（200 字），剩下的交给宽度；全文照旧留好", () => {
		const command = `git commit -m "${"很长的提交说明".repeat(20)}"`;
		const info = describeTool("bash", JSON.stringify({ command }));
		assert.ok((info.detail ?? "").length <= 201, `detail 太长：${info.detail}`);
		// 没超过上限时不该被提前断掉（旧实现 64 字就断，用户 2026-11-02 报「太短」）
		const short = `cd /repo && npm run build:web 2>&1 | grep -E "index-.*js" | tail -2`;
		assert.equal(describeTool("bash", JSON.stringify({ command: short })).detail, short);
		assert.equal(info.full, command);
	});

	it("给了 argsFull 就该看全：弹层用原文，行尾仍是一截", () => {
		// 服务端把 argsSummary 截到 200 字（快照别被长命令撞大），argsFull 才是原始命令
		const command = `cd /repo && ./bin/tool --flag=${"甲".repeat(300)}`;
		const summary = JSON.stringify({ command: command.slice(0, 200) });
		const info = describeTool("bash", summary, JSON.stringify({ command }));
		assert.equal(info.full, command);
		assert.ok((info.detail ?? "").length <= 201, `detail 太长：${(info.detail ?? "").length}`);
	});

	it("没有 argsFull 时退回摘要（老快照 / 摘要本来就够短）", () => {
		const command = "cd /repo && npm test";
		const info = describeTool("bash", JSON.stringify({ command }));
		assert.equal(info.full, command);
	});

	it("读文件 / 技能这种没有「更多可看」的，full 为 null（不给一个点不开的按钮）", () => {
		assert.equal(describeTool("read", '{"path":"/repo/a.md"}').full, null);
		assert.equal(describeTool("read", '{"path":"/repo/skills/weather-forecast/SKILL.md"}').full, null);
	});
});
