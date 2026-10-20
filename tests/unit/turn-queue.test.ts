import { describe, expect, it } from "vitest";
import { createTurnQueue } from "../../server/session/turn-queue.js";

describe("turn queue", () => {
	it("每条排队消息有独立 id，并按会话取队首", () => {
		const queue = createTurnQueue();
		queue.push({ id: "q-a", conversationId: "a", text: "a1" });
		queue.push({ id: "q-b", conversationId: "b", text: "b1" });
		queue.push({ id: "q-a2", conversationId: "a", text: "a2" });

		expect(queue.shift("a")?.id).toBe("q-a");
		expect(queue.shift("a")?.id).toBe("q-a2");
		expect(queue.shift("b")?.id).toBe("q-b");
	});

	it("按 id 真正删除排队项，不会在之后出队", () => {
		const queue = createTurnQueue();
		queue.push({ id: "q-1", conversationId: "conv-1", text: "不要发送" });
		queue.push({ id: "q-2", conversationId: "conv-1", text: "保留" });

		expect(queue.remove("q-1")).toBe(true);
		expect(queue.remove("q-1")).toBe(false);
		expect(queue.shift("conv-1")).toMatchObject({ id: "q-2", text: "保留" });
		expect(queue.views()).toEqual([]);
	});

	it("不同会话的同文案不会互相影响", () => {
		const queue = createTurnQueue();
		queue.push({ id: "q-a", conversationId: "a", text: "相同文字" });
		queue.push({ id: "q-b", conversationId: "b", text: "相同文字" });

		expect(queue.remove("q-b")).toBe(true);
		expect(queue.shift("a")?.conversationId).toBe("a");
		expect(queue.shift("b")).toBeNull();
	});
});
