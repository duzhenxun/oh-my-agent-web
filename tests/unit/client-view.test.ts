/**
 * 每个客户端一份「当前会话」（ADR-0033）。
 * 这一层的存在理由：`state.activeId` 是全局的，多标签/多设备会互相拽着切换。
 */
import { describe, expect, it } from "vitest";
import { createClientView } from "../../server/session/client-view.js";

describe("clientView", () => {
	it("没记录时回落到全局 activeId", () => {
		const view = createClientView();
		expect(view.activeFor("tab-a", "conv-1")).toBe("conv-1");
		expect(view.activeFor(undefined, "conv-1")).toBe("conv-1");
	});

	it("各客户端互不影响（本地切到 B，远程仍看 A）", () => {
		const view = createClientView();
		view.setActive("tab-a", "conv-a");
		view.setActive("tab-b", "conv-b");
		expect(view.activeFor("tab-a", null)).toBe("conv-a");
		expect(view.activeFor("tab-b", null)).toBe("conv-b");
	});

	it("会话被删/归档时清掉指向它的记录", () => {
		const view = createClientView();
		view.setActive("tab-a", "gone");
		view.setActive("tab-b", "keep");
		view.forget("gone");
		expect(view.activeFor("tab-a", "fallback")).toBe("fallback");
		expect(view.activeFor("tab-b", null)).toBe("keep");
	});

	it("断开连接时清掉该客户端", () => {
		const view = createClientView();
		view.setActive("tab-a", "conv-a");
		view.drop("tab-a");
		expect(view.size()).toBe(0);
	});
});
