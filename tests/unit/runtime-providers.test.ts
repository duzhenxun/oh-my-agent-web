/**
 * 自定义 provider 必须在**启动时**就读进来（回归 bug：只有点过 provider 相关按钮才可见）。
 */
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/runtime-harness.js";
import { createFakeEngine } from "../../server/engine/fake.js";
import { createMemoryRuleStore } from "../../server/approval/rules.js";
import { createRuntime } from "../../server/session/runtime.js";

/** 一个能被观测到「预热顺序」的 runtime（预热 → 取模型表 → 读 provider） */
function createRuntimeWithWarm(hooks: { onPrewarm: () => void; onLoad: () => void }) {
	const engine = createFakeEngine({ chunkDelayMs: 0, slowChunkDelayMs: 5 });
	engine.prewarm = async () => hooks.onPrewarm();
	return createRuntime({
		engine,
		rules: createMemoryRuleStore(),
		piSessions: async () => [],
		loadProviders: async () => {
			hooks.onLoad();
			return [];
		},
		workspace: "/tmp/agent-web-test",
		emit: { snapshot: () => {}, event: () => {} },
	});
}

const custom = (name: string) => ({
	provider: name,
	source: "custom" as const,
	baseUrl: `https://${name}.example.com/v1`,
	api: "openai-completions",
	hasKey: true,
	keyHint: "…abcd",
	models: [{ id: "m1", name: "M1" }],
});

describe("provider 列表进快照", () => {
	it("init 就读一次：不用点任何按钮，模型面板里就有自定义 provider", async () => {
		const list = [custom("my-gw")];
		const { runtime } = harness(undefined, { loadProviders: async () => list });
		await runtime.init();
		expect(runtime.snapshot().providers.map((provider) => provider.provider)).toEqual(["my-gw"]);
	});

	it("refreshProviders 重新读（外部改过 models-store.json 也能刷新出来）", async () => {
		const list = [custom("my-gw")];
		const { runtime } = harness(undefined, { loadProviders: async () => [...list] });
		await runtime.init();
		list.push(custom("second-gw"));
		await runtime.refreshProviders();
		expect(runtime.snapshot().providers).toHaveLength(2);
	});

	it("没注入 loadProviders 时不炸（单测/假引擎场景）", async () => {
		const { runtime } = harness();
		await runtime.init();
		expect(runtime.snapshot().providers).toEqual([]);
	});
});

describe("启动预热（没打开任何会话也要列全 provider）", () => {
	it("init 会先预热引擎、把模型表放进快照，再读 provider 列表", async () => {
		let prewarmed = 0;
		let listedAfterPrewarm = false;
		const runtime = createRuntimeWithWarm({
			onPrewarm: () => {
				prewarmed += 1;
			},
			onLoad: () => {
				listedAfterPrewarm = prewarmed > 0;
			},
		});
		await runtime.init();
		expect(prewarmed).toBe(1);
		expect(listedAfterPrewarm).toBe(true); // 顺序很重要：先预热，provider 才拿得到内置分组
		expect(runtime.snapshot().models.length).toBeGreaterThan(0);
	});
});
