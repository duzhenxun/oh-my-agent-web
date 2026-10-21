/**
 * 新会话的起手模型：**跟着项目走**，而不是跟着「上次随便用过的」。
 *
 * 两个来源：① 用户在模型面板里钉的项目默认（settings.defaultModels）；
 * ② 没钉过就用这个项目里**最近一个会话**用过的模型。
 */
import { describe, expect, it } from "vitest";
import { createMemoryRuleStore } from "../../server/approval/rules.js";
import { harness } from "./helpers/runtime-harness.js";

const project = (cwd: string, sessions: { id: string; model: string | null; updatedAt: number }[]) => ({
	cwd,
	name: cwd.split("/").pop() ?? cwd,
	sessions: sessions.map((session) => ({
		id: session.id,
		title: session.id,
		startedAt: 1,
		updatedAt: session.updatedAt,
		cwd,
		model: session.model,
		sessionPath: `/tmp/pi-sessions/${session.id}.jsonl`,
	})),
});

const projects = [
	project("/repo/a", [
		{ id: "a1", model: "p/a-old", updatedAt: 100 },
		{ id: "a2", model: "p/a-new", updatedAt: 300 },
	]),
	project("/repo/b", [{ id: "b1", model: "p/b-only", updatedAt: 200 }]),
];

/** 找出假引擎最后被要求切成的模型（每次新建会话都会切一次） */
const switched = (engine: { switchedModels: () => { sessionId: string; modelId: string }[] }) => {
	const log = engine.switchedModels();
	return log[log.length - 1]?.modelId ?? null;
};

describe("新会话的默认模型（按项目）", () => {
	it("没钉默认：用**这个项目最近一个会话**的模型，不是别的项目的", async () => {
		const { runtime, engine } = harness(createMemoryRuleStore(), { piSessions: async () => projects });
		await runtime.init();
		const result = await runtime.newConversation("/repo/a");
		expect(result.ok).toBe(true);
		expect(switched(engine)).toBe("p/a-new");
	});

	it("钉了项目默认：以钉的为准（优先于最近会话）", async () => {
		const { runtime, engine, recorder } = harness(createMemoryRuleStore(), { piSessions: async () => projects });
		await runtime.init();
		await runtime.applySettings({ defaultModels: { "/repo/a": "p/pinned" } });
		expect(recorder.latest()?.settings.defaultModels).toEqual({ "/repo/a": "p/pinned" });
		await runtime.newConversation("/repo/a");
		expect(switched(engine)).toBe("p/pinned");
	});

	it("项目里还没有会话、也没钉默认：退回界面上选着的模型", async () => {
		const { runtime, engine } = harness(createMemoryRuleStore(), { piSessions: async () => projects });
		await runtime.init();
		await runtime.newConversation("/repo/a");
		const selected = await runtime.setModel("fake/beta"); // 用户在选择器上换了一个
		expect(selected.ok).toBe(true);
		await runtime.newConversation("/repo/empty"); // 空项目：没有项目口味可依，就用选着的
		expect(switched(engine)).toBe("fake/beta");
	});

	it("取消项目默认（传空表）后回到「最近会话」的模型", async () => {
		const { runtime, engine } = harness(createMemoryRuleStore(), { piSessions: async () => projects });
		await runtime.init();
		await runtime.applySettings({ defaultModels: { "/repo/b": "p/pinned" } });
		await runtime.newConversation("/repo/b");
		expect(switched(engine)).toBe("p/pinned");
		await runtime.applySettings({ defaultModels: {} });
		await runtime.newConversation("/repo/b");
		expect(switched(engine)).toBe("p/b-only");
	});
});
