/**
 * 右侧分栏「刷新后恢复」的纯函数（`web/src/preview-tabs-pref.ts`）。
 *
 * 钉三件事：
 *   - **终端与临时聊天不存**（活着的东西刷新后不该"复活"）；
 *   - 存下来的是纯数据（路径 / 地址），恢复时 id 重新生成，文件的 id 跟 `openFileInPanel` 同一条规则；
 *   - 坏记录 / 缺字段只丢坏的那一条，不整个放弃（用户手改过 localStorage 也不该丢掉整排标签）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_RESTORED_TABS,
	parsePanelState,
	restorePanelItems,
	serializePanelState,
	toStoredTabs,
} from "../../web/src/preview-tabs-pref.ts";

describe("toStoredTabs", () => {
	it("文件 / 网页 / 文件树存，终端与临时聊天丢掉", () => {
		const tabs = toStoredTabs([
			{ id: "f", kind: "file", path: "a.ts", root: "/p" },
			{ id: "t", kind: "terminal", cwd: "/p" },
			{ id: "w", kind: "web", url: "https://example.com" },
			{ id: "d", kind: "files" },
			{ id: "s", kind: "side" },
		]);
		assert.deepEqual(tabs, [
			{ kind: "file", path: "a.ts", root: "/p" },
			{ kind: "web", url: "https://example.com" },
			{ kind: "files" },
		]);
	});

	it("最多只留 MAX_RESTORED_TABS 条", () => {
		const many = Array.from({ length: MAX_RESTORED_TABS + 5 }, (_, i) => ({
			id: `w${i}`,
			kind: "web" as const,
			url: `u${i}`,
		}));
		assert.equal(toStoredTabs(many).length, MAX_RESTORED_TABS);
	});
});

describe("restorePanelItems", () => {
	it("文件的 id 跟 openFileInPanel 同一条规则（不会开出两份同一个文件）", () => {
		const [item] = restorePanelItems([{ kind: "file", path: "a.ts", root: "/p" }]);
		assert.deepEqual(item, { id: "file:/p:a.ts", kind: "file", path: "a.ts", root: "/p" });
	});

	it("网页的 id 各自唯一（不跟运行时的 seq 撞车）", () => {
		const items = restorePanelItems([
			{ kind: "web", url: "" },
			{ kind: "web", url: "u" },
		]);
		assert.equal(new Set(items.map((each) => each.id)).size, 2);
	});
});

describe("parsePanelState", () => {
	it("没存过 / 坏 JSON / 空标签 → null", () => {
		assert.equal(parsePanelState(null), null);
		assert.equal(parsePanelState("not json"), null);
		assert.equal(parsePanelState(JSON.stringify({ tabs: [] })), null);
	});

	it("缺字段的那一条丢掉，其余照旧恢复", () => {
		const raw = JSON.stringify({
			tabs: [
				{ kind: "file", path: "a.ts", root: "/p" },
				{ kind: "file", root: "/p" },
				{ kind: "web", url: "u" },
			],
			active: "file:/p:a.ts",
			open: true,
		});
		const state = parsePanelState(raw);
		assert.equal(state?.tabs.length, 2);
		assert.equal(state?.active, "file:/p:a.ts");
		assert.equal(state?.open, true);
	});
});

describe("serializePanelState", () => {
	it("聚焦的那条是终端（不恢复）→ active 存成 null", () => {
		const items = [
			{ id: "file:/p:a.ts", kind: "file" as const, path: "a.ts", root: "/p" },
			{ id: "term:1:/p", kind: "terminal" as const, cwd: "/p" },
		];
		const parsed = JSON.parse(serializePanelState(items, "term:1:/p", true)) as {
			active: string | null;
			tabs: unknown[];
		};
		assert.equal(parsed.active, null);
		assert.equal(parsed.tabs.length, 1);
	});

	it("聚焦的那条还在 → 原样存", () => {
		const items = [{ id: "file:/p:a.ts", kind: "file" as const, path: "a.ts", root: "/p" }];
		const parsed = JSON.parse(serializePanelState(items, "file:/p:a.ts", false)) as {
			active: string | null;
			open: boolean;
		};
		assert.equal(parsed.active, "file:/p:a.ts");
		assert.equal(parsed.open, false);
	});
});
