import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_PANEL_ORDER,
	movePanel,
	normalizePanelOrder,
	readPanelOrder,
	samePanelOrder,
} from "../../web/src/panel-order.ts";
import { layoutPanelTabs, panelTabTargetIndex, type PanelTabBox } from "../../web/src/panel-tab-dnd.ts";
import type { PanelKey } from "../../web/src/panel-order.ts";

describe("panel order preferences", () => {
	it("空值和坏 JSON 都回退到当前默认顺序", () => {
		assert.deepEqual(readPanelOrder(null), DEFAULT_PANEL_ORDER);
		assert.deepEqual(readPanelOrder("bad json"), DEFAULT_PANEL_ORDER);
	});

	it("清洗重复项和未知项，并补齐旧版本缺少的新面板", () => {
		assert.deepEqual(normalizePanelOrder(["settings", "voice", "voice", "unknown", "mcp"]), [
			"settings",
			"voice",
			"mcp",
			"skills",
			"push",
			"plugins",
			"models",
			"agents",
		]);
	});

	it("移动、越界夹取和顺序比较", () => {
		assert.deepEqual(movePanel(["voice", "skills", "push"], "voice", 2), ["skills", "push", "voice"]);
		assert.deepEqual(movePanel(["voice", "skills", "push"], "push", 0), ["push", "voice", "skills"]);
		assert.deepEqual(movePanel(["voice", "skills", "push"], "voice", 99), ["skills", "push", "voice"]);
		assert.ok(samePanelOrder([...DEFAULT_PANEL_ORDER], DEFAULT_PANEL_ORDER));
		assert.ok(!samePanelOrder(["voice", "skills"], ["skills", "voice"]));
	});
});

describe("panel tab drag math", () => {
	const order: PanelKey[] = ["voice", "skills", "push", "models"];
	const boxes = new Map<PanelKey, PanelTabBox>([
		["voice", { left: 0, width: 100 }],
		["skills", { left: 106, width: 80 }],
		["push", { left: 192, width: 60 }],
		["models", { left: 258, width: 90 }],
	]);

	it("按原始兄弟中心决定插入位置，支持不同宽度的 Tab", () => {
		assert.equal(panelTabTargetIndex(order, "voice", 50, boxes), 0);
		assert.equal(panelTabTargetIndex(order, "voice", 146, boxes), 1);
		assert.equal(panelTabTargetIndex(order, "voice", 223, boxes), 2);
		assert.equal(panelTabTargetIndex(order, "voice", 400, boxes), 3);
	});

	it("预览布局从原始最左槽位开始，让位距离包含 gap", () => {
		const preview = layoutPanelTabs(["skills", "voice", "push", "models"], boxes, 6);
		assert.deepEqual(Object.fromEntries(preview), { skills: 0, voice: 86, push: 192, models: 258 });

		const last = layoutPanelTabs(["skills", "push", "models", "voice"], boxes, 6);
		assert.deepEqual(Object.fromEntries(last), { skills: 0, push: 86, models: 152, voice: 248 });
	});
});
