/**
 * 审批模式（P4）：`allow` = 本会话放行。
 * 两条最要紧的断言：**放行时不弹窗**、**默认仍是询问**（不许悄悄变宽）。
 */
import { describe, expect, it } from "vitest";
import { createApprovalBridge } from "../../server/session/approval-bridge.js";
import type { PendingApproval } from "../../server/protocol.js";

function makeBridge() {
	const pendingList: (PendingApproval | null)[] = [];
	const notices: string[] = [];
	let seq = 0;
	const bridge = createApprovalBridge({
		rules: { load: async () => [], save: async () => {} },
		now: () => 1,
		nextId: (prefix) => `${prefix}-${++seq}`,
		onPending: (pending) => pendingList.push(pending),
		onNotice: (text) => notices.push(text),
	});
	return { bridge, pendingList, notices };
}

const request = {
	toolName: "bash",
	argsSummary: "rm -rf build",
	riskNote: "危险",
	scopeKey: "bash:rm",
	scopeHint: "bash rm",
};

describe("审批模式", () => {
	it("默认是 ask：危险操作会弹窗等人", async () => {
		const { bridge, pendingList } = makeBridge();
		expect(bridge.mode()).toBe("ask");
		void bridge.handler(request);
		expect(pendingList.at(-1)?.toolName).toBe("bash");
	});

	it("allow：不弹窗，直接放行一次", async () => {
		const { bridge, pendingList } = makeBridge();
		bridge.setMode("allow");
		const decision = await bridge.handler(request);
		expect(decision).toBe("once");
		expect(pendingList).toEqual([]);
	});

	it("allow 不记忆、不写盘：切回 ask 就重新询问", async () => {
		const { bridge, pendingList } = makeBridge();
		bridge.setMode("allow");
		await bridge.handler(request);
		bridge.setMode("ask");
		void bridge.handler(request);
		expect(pendingList.at(-1)?.toolName).toBe("bash");
	});

	it("悬着的弹窗不会因为切到 allow 而凭空消失", async () => {
		const { bridge, pendingList } = makeBridge();
		void bridge.handler(request);
		const requestId = pendingList.at(-1)?.requestId ?? "";
		bridge.setMode("allow");
		expect(pendingList.at(-1)?.requestId).toBe(requestId);
	});
});
