/**
 * 「提 Bug」拼 issue 的纯逻辑：脱敏 / 截断 / URL 编码。
 *
 * 这几条都是「错了也不会报错，只会把用户名或 token 悄悄贴到公开 issue 里」的那类坑，
 * 所以逐条钉住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BUG_BODY_MAX,
	BUG_TITLE_MAX,
	bugIssueBody,
	bugIssueTitle,
	bugIssueUrl,
	bugReportText,
	redact,
	type BugReport,
} from "../../web/src/bug-report.ts";

const base: BugReport = {
	summary: "点发送之后消息被顶栏挡住了",
	detail: "期望：消息在顶栏下面；实际：上半截看不见",
	version: "0.1.3",
	engine: "pi",
	engineVersion: "1.3.0",
	model: "claude-haiku-4.5",
	sessionId: "abc123",
	platform: "Macintosh; Intel Mac OS X 10_15_7",
};

describe("提 Bug：脱敏", () => {
	it("家目录换成 ~（mac / linux / windows 三种写法）", () => {
		assert.equal(redact("/Users/dszx/data/ai/oh-my-agent-web"), "~/data/ai/oh-my-agent-web");
		assert.equal(redact("/home/me/work"), "~/work");
		assert.equal(redact("C:\\Users\\dszx\\work"), "~\\work");
	});

	it("用户名后面接空格 / 引号 / 结尾都认得出来", () => {
		assert.equal(redact("工作区 /Users/dszx"), "工作区 ~");
		assert.equal(redact('"/Users/dszx"'), '"~"');
	});

	it("常见密钥打码，普通文本不动", () => {
		assert.equal(redact("key=sk-abcdefghijklmnop"), "key=***");
		assert.equal(redact("ghp_abcdefghijklmnopqrst"), "***");
		assert.equal(redact("AKIAIOSFODNN7EXAMPLE"), "***");
		assert.equal(redact("普通的一句话 /tmp/x.log"), "普通的一句话 /tmp/x.log");
	});
});

describe("提 Bug：标题", () => {
	it("压成一行并去掉首尾空白", () => {
		assert.equal(bugIssueTitle({ summary: "  消息\n被挡住  " }), "消息 被挡住");
	});

	it("超过上限截断到上限以内（含省略号）", () => {
		const title = bugIssueTitle({ summary: "很长".repeat(200) });
		assert.equal(title.length, BUG_TITLE_MAX);
		assert.ok(title.endsWith("…"));
	});

	it("用户没写标题就返回空串（面板据此禁用按钮）", () => {
		assert.equal(bugIssueTitle({ summary: "   " }), "");
	});
});

describe("提 Bug：正文", () => {
	it("带上环境与用户描述", () => {
		const body = bugIssueBody(base);
		assert.match(body, /## 发生了什么/);
		assert.match(body, /期望：消息在顶栏下面/);
		assert.match(body, /版本：0\.1\.3/);
		assert.match(body, /引擎：pi 1\.3\.0/);
		assert.match(body, /模型：claude-haiku-4\.5/);
		assert.match(body, /会话：abc123/);
	});


	it("描述留空时给一句占位提示，而不是留白", () => {
		assert.match(bugIssueBody({ ...base, detail: "  " }), /可以补充：期望看到什么/);
	});

	it("超长正文截断（否则整条塞进 URL 会被浏览器截掉尾巴）", () => {
		const body = bugIssueBody({ ...base, detail: "啊".repeat(9000) });
		assert.ok(body.length <= BUG_BODY_MAX, `正文 ${body.length} 超了上限`);
		assert.ok(body.endsWith("…（已截断）"));
	});

	it("正文里的家目录也脱敏（用户自己粘的路径同样不能泄露）", () => {
		const body = bugIssueBody({ ...base, detail: "日志在 /Users/dszx/.oh-my-agent-web/log.txt" });
		assert.doesNotMatch(body, /Users\/dszx/);
		assert.match(body, /~\/\.oh-my-agent-web\/log\.txt/);
	});
});

describe("提 Bug：链接", () => {
	it("指向自己仓库的 issues/new，预填标题 / 正文 / bug 标签", () => {
		const url = new URL(bugIssueUrl(base));
		assert.equal(url.origin + url.pathname, "https://github.com/duzhenxun/oh-my-agent-web/issues/new");
		assert.equal(url.searchParams.get("title"), base.summary);
		assert.equal(url.searchParams.get("labels"), "bug");
		assert.match(url.searchParams.get("body") ?? "", /## 环境/);
	});

	it("换行 / & / # 这些字符编码后还能原样取回来", () => {
		const nasty = { ...base, summary: "A&B #1", detail: "第一行\n第二行 & 收尾" };
		const url = new URL(bugIssueUrl(nasty));
		assert.equal(url.searchParams.get("title"), "A&B #1");
		assert.match(url.searchParams.get("body") ?? "", /第一行\n第二行 & 收尾/);
	});

	it("没写标题也不会拼出空的 title 参数", () => {
		const url = new URL(bugIssueUrl({ ...base, summary: "" }));
		assert.ok((url.searchParams.get("title") ?? "").length > 0);
	});

	it("复制出来的那份 = 标题 + 正文", () => {
		const text = bugReportText(base);
		assert.ok(text.startsWith(base.summary));
		assert.ok(text.includes(bugIssueBody(base)));
	});
});
