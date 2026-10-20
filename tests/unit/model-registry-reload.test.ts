/**
 * 自定义 provider 要能被 pi 立刻用上（回归：加了 abc 但模型选择器里没有）。
 *
 * `ModelRuntime.refresh()` 只重拉「动态 provider 的远端目录」，不会重新读 models.json，
 * 所以必须对活着的会话调 `registerProvider()`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProviderConfigs, reloadModelRegistry } from "../../server/engine/model-registry-reload.js";

let agentDir = "";
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-web-reload-"));
	mkdirSync(agentDir, { recursive: true });
});
afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe("readProviderConfigs", () => {
	it("目录（models.json）里的 provider 带 api / baseUrl / key / models", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					abc: { api: "openai-completions", baseUrl: "https://x/v1", apiKey: "sk-a", models: [{ id: "m1" }] },
				},
			}),
		);
		const configs = await readProviderConfigs(agentDir);
		expect(configs).toHaveLength(1);
		expect(configs[0]).toMatchObject({ id: "abc", api: "openai-completions", baseUrl: "https://x/v1", apiKey: "sk-a" });
	});

	it("models-store.json 的 provider 用 auth.json 里的 key", async () => {
		writeFileSync(
			join(agentDir, "models-store.json"),
			JSON.stringify({
				gw: { models: [{ id: "m1", api: "openai-completions", baseUrl: "https://y" }] },
			}),
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ gw: { key: "sk-gw" } }));
		const configs = await readProviderConfigs(agentDir);
		expect(configs[0]).toMatchObject({ id: "gw", api: "openai-completions", baseUrl: "https://y", apiKey: "sk-gw" });
	});

	it("文件都不存在时返回空表（不抛）", async () => {
		expect(await readProviderConfigs(agentDir)).toEqual([]);
	});
});

describe("reloadModelRegistry", () => {
	it("重建预热会话，并把配置 registerProvider 给每个活着的会话", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { abc: { api: "openai-completions", baseUrl: "https://x", models: [{ id: "m1" }] } },
			}),
		);
		const registerProvider = vi.fn();
		const refresh = vi.fn(async () => undefined);
		const sessions = new Map([
			["live", { unsubscribe: () => {}, session: { dispose: () => {}, modelRuntime: { registerProvider, refresh } } }],
			["__prewarm__", { unsubscribe: () => {}, session: { dispose: () => {} } }],
		]);
		const prewarm = vi.fn(async () => undefined);

		await reloadModelRegistry(sessions as never, "__prewarm__", prewarm, agentDir);

		expect(prewarm).toHaveBeenCalled(); // 预热会话被丢掉后重建
		expect(registerProvider).toHaveBeenCalledWith("abc", expect.objectContaining({ baseUrl: "https://x" }));
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
	});
});
