/**
 * 「刚发出去的消息自己顶到上方」时，别把它顶到**浮起来的顶栏**后面。
 *
 * 顶栏浮在对话列之上时（手机壳 / 窄屏下那圈浮动工具条），正文从 y=0 起滚、从它后面滑过去；
 * 锚点以前只退 10px 呼吸带，于是那条消息正好落在顶栏后面、上半截被切掉。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anchorOffsetFor } from "../../web/src/stick-to-bottom.ts";

describe("锚点让开浮起来的顶栏", () => {
	it("浏览器里（视口顶部没被盖住）还是原来的 10px 呼吸带", () => {
		assert.equal(anchorOffsetFor(400), 390);
		assert.equal(anchorOffsetFor(400, 0), 390);
	});

	it("顶栏浮起来时再退一整个顶栏高，消息落在顶栏下面而不是后面", () => {
		// 顶栏 33px（--appbar-h 实量）→ 消息顶边落在视口往下 33 + 10 = 43px 处
		assert.equal(anchorOffsetFor(400, 33), 357);
		assert.equal(anchorOffsetFor(400, 33) + 33 + 10, 400);
	});

	it("第一条消息本来就贴着顶（offset 小于要退的量）时不滚成负数", () => {
		assert.equal(anchorOffsetFor(20, 33), 0);
		assert.equal(anchorOffsetFor(0, 33), 0);
	});

	it("顶栏高度是脏值（负数 / NaN）时按没盖住算，不至于滚到反方向", () => {
		assert.equal(anchorOffsetFor(400, -30), 390);
		assert.equal(anchorOffsetFor(400, Number.NaN), 400 - 10 - 0);
	});

});
