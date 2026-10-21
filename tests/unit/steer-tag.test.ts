/**
 * 「引导」标记：回合进行中把消息插进当前这一轮（steer）时，那条用户消息要带 steer=true，
 * 界面据此打上「引导」标签（和排队中的「排队」区分开）。普通发送不带这个标记。
 */
import { describe, expect, it } from "vitest";
import { harness, waitFor } from "./helpers/runtime-harness.js";

describe("引导标记", () => {
	it("回合进行中用 steer 发：那条用户消息带 steer=true", async () => {
		const { runtime } = harness();
		await runtime.init();
		// 先起一个慢回合（假引擎的 slow 剧本），趁它没跑完再 steer 一条
		void runtime.sendMessage("slow please");
		await waitFor(() => runtime.snapshot().running.status === "streaming");
		await runtime.sendMessage("插一句", undefined, "steer");
		await waitFor(() => runtime.snapshot().active.messages.some((message) => message.steer === true));
		const steer = runtime.snapshot().active.messages.find((message) => message.steer === true);
		expect(steer?.role).toBe("user");
		expect(steer?.blocks.some((block) => block.kind === "text" && block.text.includes("插一句"))).toBe(true);
	});

	it("空闲时正常发：不带 steer 标记", async () => {
		const { runtime } = harness();
		await runtime.init();
		await runtime.sendMessage("普通一条");
		const users = runtime.snapshot().active.messages.filter((message) => message.role === "user");
		expect(users.every((message) => !message.steer)).toBe(true);
	});
});
