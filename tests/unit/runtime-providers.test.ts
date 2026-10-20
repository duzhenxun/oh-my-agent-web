/**
 * 自定义 provider 必须在**启动时**就读进来（回归 bug：只有点过 provider 相关按钮才可见）。
 */
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/runtime-harness.js";

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
