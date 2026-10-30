/**
 * 聊天区显示偏好：字号 / 内容宽度（`web/src/chat-display.ts`）。
 *
 * 这两项是「这台设备怎么显示」的本机偏好（跟主题同一类）：存 localStorage、
 * 首帧前写到 `<html>` 的 CSS 变量上，不进快照。
 *
 * 字号现在是**连续像素值**（设置 → 外观里是滑杆），所以这里锁住的是：
 * 默认值不变、老版本存的档位 id 还能读、坏值不会把界面拖成奇怪的字号；
 * 宽度那边锁住「满宽必须映射成 100%（而不是 none）」——布局要拿它做 calc。
 *
 * 宽度也是滑杆之后，存的从「档位 id」变成了**像素值**（`0` = 满宽）：
 * 老 key 里的 `narrow` / `normal` / `wide` / `full` 仍然认，映射成对应像素。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CHAT_WIDTHS,
	CHAT_WIDTH_MIN_PX,
	CHAT_WIDTH_STEP_PX,
	clampChatWidthPx,
	cssVarsOf,
	findChatWidth,
	readStoredFont,
	readStoredWidth,
} from "../../web/src/chat-display.ts";
import { DEFAULT_FONT_PX, FONT_LADDERS } from "../../web/src/font-scale.ts";

const CHAT_DEFAULT = DEFAULT_FONT_PX.chat;

describe("默认值：改这个设置之前的样子", () => {
	it("没存过 → 标准字号 + 满宽", () => {
		assert.equal(readStoredFont(null), CHAT_DEFAULT);
		assert.equal(readStoredWidth(null), 0); // 0 = 满宽
	});

	it("默认字号 = 「标准」14px（聊天正文那一档）", () => {
		assert.equal(CHAT_DEFAULT, 14);
		assert.equal(FONT_LADDERS.chat.find((item) => item.id === "m")?.px, CHAT_DEFAULT);
	});

	it("满宽 → 100%（不是 none）", () => {
		assert.equal(cssVarsOf(CHAT_DEFAULT, 0).maxWidth, "100%");
	});
});

describe("字号取值：新值、老档位、坏值", () => {
	it("存像素：对齐到双数后读回来", () => {
		assert.equal(readStoredFont("11.5"), 12);
		assert.equal(readStoredFont("13"), 14);
	});

	it("存的是老挡位 id：按新刻度映射成像素（升级后仍然读得出「我改过字号」）", () => {
		assert.equal(readStoredFont("l"), 16);
		assert.equal(readStoredFont("xl"), 18);
	});

	it("坏值回落到默认", () => {
		assert.equal(readStoredFont("huge"), CHAT_DEFAULT);
		assert.equal(readStoredFont(""), CHAT_DEFAULT);
		assert.equal(readStoredFont("M"), CHAT_DEFAULT); // 大小写不认，也不炸
	});

	it("宽度坏值回落到满宽（findChatWidth 对未知 id 返回 null）", () => {
		assert.equal(readStoredWidth("9999px"), 0); // 带单位 = 坏值
		assert.equal(readStoredWidth(""), 0);
		assert.equal(findChatWidth("huge"), null);
	});

	it("存像素：夹到滑杆区间并对齐步长", () => {
		assert.equal(readStoredWidth("900"), 900);
		assert.equal(readStoredWidth("937"), 940); // 对齐到 20 的刻度
		assert.equal(readStoredWidth("100"), CHAT_WIDTH_MIN_PX); // 比左端还窄 → 顶到 480
	});

	it("老版本存的是档位 id：映射成同一档的像素", () => {
		for (const width of CHAT_WIDTHS) assert.equal(readStoredWidth(width.id), width.px);
	});
});

describe("cssVarsOf：写到 <html> 上的两个值", () => {
	it("每个快捷档都映射成 px（连续值同样支持）", () => {
		for (const font of FONT_LADDERS.chat) {
			assert.equal(cssVarsOf(font.px, 0).size, `${font.px}px`);
		}
		assert.equal(cssVarsOf(11.5, "full").size, "12px"); // 非双数会被对齐
	});

	it("每个宽度都映射成 px（满宽 100%）", () => {
		for (const width of CHAT_WIDTHS) {
			const expected = width.px > 0 ? `${width.px}px` : "100%";
			assert.equal(cssVarsOf(CHAT_DEFAULT, width.px).maxWidth, expected);
		}
	});

	it("字号与宽度互相独立（换字号不会把宽度带回默认）", () => {
		assert.equal(cssVarsOf(16, 720).size, "16px");
		assert.equal(cssVarsOf(16, 720).maxWidth, "720px");
	});

	it("滑杆刻度：0 与负数都是满宽，其余落在 480 + n*20 上", () => {
		assert.equal(clampChatWidthPx(0), 0);
		assert.equal(clampChatWidthPx(-40), 0);
		assert.equal(clampChatWidthPx(Number.NaN), 0);
		assert.equal(clampChatWidthPx(500), CHAT_WIDTH_MIN_PX + CHAT_WIDTH_STEP_PX);
		for (const px of [480, 501, 937, 1280]) {
			const clamped = clampChatWidthPx(px);
			assert.equal((clamped - CHAT_WIDTH_MIN_PX) % CHAT_WIDTH_STEP_PX, 0);
		}
	});

	it("快捷档从小到大单调递增（滑杆刻度与卡片顺序一致）", () => {
		const sizes = FONT_LADDERS.chat.map((item) => item.px);
		assert.deepEqual(
			sizes,
			[...sizes].sort((a, b) => a - b),
		);
	});
});
