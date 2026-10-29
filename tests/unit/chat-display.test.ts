/**
 * 聊天区显示偏好：字号 / 内容宽度（`web/src/chat-display.ts`）。
 *
 * 这两项是「这台设备怎么显示」的本机偏好（跟主题同一类）：存 localStorage、
 * 首帧前写到 `<html>` 的 CSS 变量上，不进快照。
 *
 * 字号现在是**连续像素值**（设置 → 外观里是滑杆），所以这里锁住的是：
 * 默认值不变、老版本存的档位 id 还能读、坏值不会把界面拖成奇怪的字号；
 * 宽度那边锁住「满宽必须映射成 100%（而不是 none）」——布局要拿它做 calc。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_WIDTHS, cssVarsOf, findChatWidth, readStoredFont, readStoredWidth } from "../../web/src/chat-display.ts";
import { DEFAULT_FONT_PX, FONT_LADDERS } from "../../web/src/font-scale.ts";

const CHAT_DEFAULT = DEFAULT_FONT_PX.chat;

describe("默认值：改这个设置之前的样子", () => {
	it("没存过 → 标准字号 + 满宽", () => {
		assert.equal(readStoredFont(null), CHAT_DEFAULT);
		assert.equal(readStoredWidth(null), "full");
	});

	it("默认字号 = 「标准」12px（聊天正文那一档）", () => {
		assert.equal(CHAT_DEFAULT, 12);
		assert.equal(FONT_LADDERS.chat.find((item) => item.id === "m")?.px, CHAT_DEFAULT);
	});

	it("满宽 → 100%（不是 none）", () => {
		assert.equal(cssVarsOf(CHAT_DEFAULT, "full").maxWidth, "100%");
	});
});

describe("字号取值：新值、老档位、坏值", () => {
	it("存像素：原样读回来", () => {
		assert.equal(readStoredFont("11.5"), 11.5);
		assert.equal(readStoredFont("13"), 13);
	});

	it("存的是老挡位 id：按新刻度映射成像素（升级后仍然读得出「我改过字号」）", () => {
		assert.equal(readStoredFont("l"), 14);
		assert.equal(readStoredFont("xl"), 16);
	});

	it("坏值回落到默认", () => {
		assert.equal(readStoredFont("huge"), CHAT_DEFAULT);
		assert.equal(readStoredFont(""), CHAT_DEFAULT);
		assert.equal(readStoredFont("M"), CHAT_DEFAULT); // 大小写不认，也不炸
	});

	it("宽度坏值回落到满宽（findChatWidth 对未知 id 返回 null）", () => {
		assert.equal(readStoredWidth("9999px"), "full");
		assert.equal(readStoredWidth(""), "full");
		assert.equal(findChatWidth("huge"), null);
	});
});

describe("cssVarsOf：写到 <html> 上的两个值", () => {
	it("每个快捷档都映射成 px（连续值同样支持）", () => {
		for (const font of FONT_LADDERS.chat) {
			assert.equal(cssVarsOf(font.px, "full").size, `${font.px}px`);
		}
		assert.equal(cssVarsOf(11.5, "full").size, "11.5px");
	});

	it("每个宽度都映射成 px（满宽 100%）", () => {
		for (const width of CHAT_WIDTHS) {
			const expected = width.px > 0 ? `${width.px}px` : "100%";
			assert.equal(cssVarsOf(CHAT_DEFAULT, width.id).maxWidth, expected);
		}
	});

	it("字号与宽度互相独立（换字号不会把宽度带回默认）", () => {
		assert.equal(cssVarsOf(16, "narrow").size, "16px");
		assert.equal(cssVarsOf(16, "narrow").maxWidth, "720px");
	});

	it("快捷档从小到大单调递增（滑杆刻度与卡片顺序一致）", () => {
		const sizes = FONT_LADDERS.chat.map((item) => item.px);
		assert.deepEqual(
			sizes,
			[...sizes].sort((a, b) => a - b),
		);
	});
});
