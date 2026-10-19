/**
 * 提示牌（ADR-0013）：同 key **原地替换**，不是每来一条就堆一行。
 * 场景：审批模式芯片反复点 —— 对话流里应该永远只有一行，跟着状态变。
 */
import { describe, expect, it } from "vitest";
import { createNoticeSink } from "../../server/session/notices.js";
import type { Notice } from "../../server/protocol.js";

function makeSink(dedupeMs = 0) {
	const pushed: Notice[] = [];
	let seq = 0;
	const sink = createNoticeSink({
		now: () => ++seq,
		nextId: (prefix) => `${prefix}-${++seq}`,
		dedupeMs,
		onNotice: (notice) => pushed.push(notice),
	});
	return { sink, pushed };
}

describe("同 key 提示替换", () => {
	it("反复推同一个 key：只留一行，内容是最新的", () => {
		const { sink } = makeSink();
		sink.push("审批模式：照旧询问", "info", "approval-mode");
		sink.push("审批模式：本会话全部放行", "warn", "approval-mode");
		sink.push("审批模式：照旧询问", "info", "approval-mode");
		const all = sink.all();
		expect(all).toHaveLength(1);
		expect(all[0]?.text).toBe("审批模式：照旧询问");
		expect(all[0]?.level).toBe("info");
		expect(all[0]?.key).toBe("approval-mode");
	});

	it("替换保留原 id（界面按 id upsert，不会闪出新行）", () => {
		const { sink } = makeSink();
		const first = sink.push("A", "info", "k");
		const second = sink.push("B", "warn", "k");
		expect(second?.id).toBe(first?.id);
	});

	it("不同 key / 不带 key 的提示照常堆叠", () => {
		const { sink } = makeSink();
		sink.push("审批模式：照旧询问", "info", "approval-mode");
		sink.push("附件已失效", "warn");
		sink.push("已附加 2 张图片", "info");
		expect(sink.all()).toHaveLength(3);
	});
});
