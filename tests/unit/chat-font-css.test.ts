/** 聊天字号必须覆盖排队 / 插队及其周边文字，不能只放大 Markdown 正文。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const messages = readFileSync(new URL("../../web/src/styles/messages.css", import.meta.url), "utf8");
const pending = readFileSync(new URL("../../web/src/styles/sent-queue.css", import.meta.url), "utf8");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = css.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return css.slice(start, end);
}

describe("聊天字号联动 CSS", () => {
	it("消息抬头、操作、用量和时间不再写死 px", () => {
		for (const selector of [".msg-head", ".msg-action", ".msg-foot", ".msg-usage-tag", ".msg-foot-stamp"]) {
			assert.match(rule(messages, selector), /--chat-ui-font-size/, selector);
		}
	});

	it("待发正文、排队 / 插队标签和收起态都使用同一聊天字号变量", () => {
		for (const selector of [".msg.msg-user.pending-item", ".sent-tag", ".steer-collapsed-row"]) {
			assert.match(rule(pending, selector), /--chat-ui-font-size/, selector);
		}
	});
});
