/**
 * 打开 pi 已有的会话（ADR-0021 §2）：点开即读、点开即续。
 * 从 runtime-session.test.ts 拆出（满足单文件 ≤400 行的护栏）。
 */
import { describe, expect, it } from "vitest";
import { createMemoryRuleStore } from "../../server/approval/rules.js";
import { harness } from "./helpers/runtime-harness.js";

describe("ADR-0021 §2：打开 pi 已有的会话（点开即读、点开即续）", () => {
	const piProjects = [
		{
			cwd: "/repo/other",
			name: "other",
			sessions: [
				{
					id: "pi-1",
					title: "pi 里的老会话",
					startedAt: 100,
					updatedAt: 200,
					cwd: "/repo/other",
					model: "demo/model",
					sessionPath: "/tmp/pi-sessions/pi-1.jsonl",
				},
			],
		},
	];

	function harnessWithPi() {
		const instance = harness(createMemoryRuleStore(), { piSessions: async () => piProjects });
		return instance;
	}

	it("切换到一个 pi 会话：走 openSession + readUiMessages，并切工作区", async () => {
		const { runtime, engine } = harnessWithPi();
		await runtime.init();
		expect(runtime.snapshot().piProjects).toHaveLength(1);

		const result = await runtime.switchConversation("pi-1");
		expect(result.ok).toBe(true);
		// 引擎确实收到了「打开」而不是「新建」
		expect(engine.sessions().get("pi-1")?.sessionPath).toBe("/tmp/pi-sessions/pi-1.jsonl");
		// 工作区跟着这个会话走（多项目，ADR-0021 §3）
		expect(runtime.snapshot().files?.root).toBe("/repo/other");
		expect(runtime.snapshot().active.conversationId).toBe("pi-1");
	});

	it("打开失败时明确报错，不会静默切过去", async () => {
		const { runtime } = harnessWithPi();
		await runtime.init();
		const result = await runtime.switchConversation("不存在");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("session.not_found");
	});

	it("给 pi 会话发消息：不再 createSession（它已经打开），回合正常结束", async () => {
		const { runtime, engine } = harnessWithPi();
		await runtime.init();
		await runtime.switchConversation("pi-1");
		const before = engine.sessions().size;

		const result = await runtime.sendMessage("接着聊");
		expect(result.ok).toBe(true);
		expect(engine.sessions().size).toBe(before); // 没有重复建会话
		expect(runtime.snapshot().active.messages.length).toBeGreaterThan(0);
	});
});
