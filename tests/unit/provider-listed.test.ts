/**
 * 左栏「这个 provider 列不列」（`web/src/provider-listed.ts`）。
 *
 * 钉住的是 2026-11-03 那个现象：`opencode` 在输入区的模型下拉里能选（引擎报了它 81 个模型），
 * 「模型」面板左栏却看不见 —— 因为它 `credential: "none"`（key 由引擎自己解析，不在 auth.json）。
 * 同时要守住反面：`openai-codex` 配着模型但没登录、引擎不报 → 仍不该混进「能用的」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineReadyProviderIds, isProviderListed } from "../../web/src/provider-listed.ts";

const engineModels = [
	"opencode/beam-free",
	"opencode/big-pickle",
	"opencode-go/qwen3.8-max",
	"deepseek-office/deepseek-flash",
	"typesafe/jev-small",
];

describe("engineReadyProviderIds", () => {
	it("取 `provider/model` 的前缀并去重", () => {
		assert.deepEqual([...engineReadyProviderIds(engineModels)].sort(), [
			"deepseek-office",
			"opencode",
			"opencode-go",
			"typesafe",
		]);
	});

	it("裸 slug / 空 id 不算任何一个 provider（codex 那种形状）", () => {
		assert.equal(engineReadyProviderIds(["deepseek-flash", "", "/opus", "opencode/"]).size, 0);
	});
});

describe("isProviderListed", () => {
	const ready = engineReadyProviderIds(engineModels);

	it("有 api key 或订阅登录的照列（原来的规则不变）", () => {
		assert.equal(isProviderListed({ provider: "opencode-go", credential: "apiKey" }, { engineReady: ready }), true);
		assert.equal(isProviderListed({ provider: "xai", credential: "oauth" }, { engineReady: ready }), true);
	});

	it("没有凭证、但引擎报了它的模型 → 列（opencode 就是这种）", () => {
		assert.equal(isProviderListed({ provider: "opencode", credential: "none" }, { engineReady: ready }), true);
	});

	it("没有凭证、引擎也没报 → 不列（没登录的 openai-codex 不该混进来）", () => {
		assert.equal(isProviderListed({ provider: "openai-codex", credential: "none" }, { engineReady: ready }), false);
		assert.equal(isProviderListed({ provider: "openai", credential: "none" }, { engineReady: ready }), false);
		// 目录里有模型数量也不算「能用」：判定不看 modelCount
		assert.equal(isProviderListed({ provider: "openrouter", credential: "none" }), false);
	});
});
