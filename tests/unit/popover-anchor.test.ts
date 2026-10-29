/**
 * 浮层锚点：贴着触发器正上方、**水平居中**（`web/src/popover-anchor.ts`）。
 *
 * 用户报的现象：点状态栏那个上下文胶囊，浮层不是从「我点的地方」冒出来的，而是偏向一侧。
 * 原因是以前按「浮层右边缘 == 胶囊右边缘」算 —— 浮层比胶囊宽得多，看起来就歪了。
 * 这里锁住三件事：居中、窄屏夹进视口、浮层比视口还宽时不出现负坐标。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { belowPopoverAnchor, centeredPopoverAnchor } from "../../web/src/popover-anchor.ts";

const viewport = { width: 1200, height: 800 };

describe("centeredPopoverAnchor", () => {
	it("居中：胶囊中心 == 浮层中心", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 600, top: 760, width: 100, height: 24 },
			popover: { width: 300 },
			viewport,
		});
		// 胶囊中心 650；浮层左边缘 650-150 = 500
		assert.equal(anchor.left, 500);
	});

	it("浮层贴在胶囊正上方（bottom = 视口高 - 胶囊顶 + 缝）", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 600, top: 760, width: 100, height: 24 },
			popover: { width: 300 },
			viewport,
		});
		assert.equal(anchor.bottom, 800 - 760 + 8);
	});

	it("靠左的胶囊：居中出现负坐标时贴左边距，不跑出屏幕", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 4, top: 760, width: 60, height: 24 },
			popover: { width: 400 },
			viewport,
		});
		assert.equal(anchor.left, 8);
	});

	it("靠右的胶囊：夹到右边距内", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 1140, top: 760, width: 56, height: 24 },
			popover: { width: 400 },
			viewport,
		});
		assert.equal(anchor.left, 1200 - 400 - 8);
	});

	it("浮层比视口还宽：贴左，不出现负数", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 10, top: 760, width: 40, height: 24 },
			popover: { width: 5000 },
			viewport,
		});
		assert.equal(anchor.left, 8);
		assert.ok(anchor.left >= 0);
	});

	it("小尾巴指向触发器中心（浮层居中时就是浮层中心）", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 600, top: 760, width: 100, height: 24 },
			popover: { width: 300 },
			viewport,
		});
		// 浮层 left=500、宽 300；触发器中心 650 → 尾巴中心应在浮层内 150 处
		assert.equal(anchor.arrow, 150);
	});

	it("浮层被夹到视口边缘时，尾巴仍然指着触发器", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 1140, top: 760, width: 56, height: 24 },
			popover: { width: 400 },
			viewport,
		});
		// 浮层 left = 792；触发器中心 = 1168 → 尾巴在浮层内 376 处
		assert.equal(anchor.left, 792);
		assert.equal(anchor.arrow, 376);
	});

	it("尾巴不会插到圆角外面（左右各留 14px）", () => {
		const left = centeredPopoverAnchor({
			trigger: { left: -200, top: 760, width: 40, height: 24 },
			popover: { width: 300 },
			viewport,
		});
		assert.equal(left.arrow, 14);
		const right = centeredPopoverAnchor({
			trigger: { left: 2000, top: 760, width: 40, height: 24 },
			popover: { width: 300 },
			viewport,
		});
		assert.equal(right.arrow, 300 - 14);
	});

	it("缝可调", () => {
		const anchor = centeredPopoverAnchor({
			trigger: { left: 600, top: 700, width: 100, height: 24 },
			popover: { width: 300 },
			viewport,
			gap: 16,
		});
		assert.equal(anchor.bottom, 800 - 700 + 16);
	});
});

describe("belowPopoverAnchor（顶栏徽标那种「往下掉」的浮层）", () => {
	const viewport = { width: 1280, height: 800 };

	it("水平居中于触发器，垂直落在它下面", () => {
		const anchor = belowPopoverAnchor({
			trigger: { left: 600, top: 12, width: 80, height: 28 },
			popover: { width: 440 },
			viewport,
		});
		// 触发器中心 640；浮层 left = 640 - 220 = 420
		assert.equal(anchor.left, 420);
		assert.equal(anchor.top, 12 + 28 + 6);
	});

	it("靠右的触发器（手机上的真实情形）：夹进视口，不再溢出屏幕", () => {
		const anchor = belowPopoverAnchor({
			trigger: { left: 300, top: 12, width: 60, height: 28 },
			popover: { width: 351 }, // 375 宽手机上空出的宽度
			viewport: { width: 375, height: 700 },
		});
		// 居中会算到 154.5，但右边只剩 16px 余量 → 夹到 375-351-8 = 16
		assert.equal(anchor.left, 375 - 351 - 8);
		assert.ok(anchor.left >= 8, "左边不能变成负数（以前 right:0 就是这个毛病）");
		assert.ok(anchor.left + 351 <= 375, "整张卡片必须留在视口内");
	});

	it("靠左的触发器同样夹回来", () => {
		const anchor = belowPopoverAnchor({
			trigger: { left: 0, top: 12, width: 40, height: 28 },
			popover: { width: 440 },
			viewport,
		});
		assert.equal(anchor.left, 8);
	});

	it("小尾巴指着触发器中心，且被夹在浮层的圆角内", () => {
		const anchor = belowPopoverAnchor({
			trigger: { left: 600, top: 12, width: 80, height: 28 },
			popover: { width: 440 },
			viewport,
		});
		assert.equal(anchor.arrow, 640 - 420);
		// 触发器在屏幕外时尾巴也不会插进圆角
		const far = belowPopoverAnchor({
			trigger: { left: 5000, top: 12, width: 40, height: 28 },
			popover: { width: 440 },
			viewport,
		});
		assert.equal(far.arrow, 440 - 14);
	});

	it("缝可调", () => {
		const anchor = belowPopoverAnchor({
			trigger: { left: 600, top: 12, width: 80, height: 28 },
			popover: { width: 440 },
			viewport,
			gap: 12,
		});
		assert.equal(anchor.top, 12 + 28 + 12);
	});
});
