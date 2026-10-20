/**
 * enabledModels 白名单的改写规则（pi settings.json）。
 *
 * 最容易出错的两处都被钉在这里：
 *   1. 全开状态（白名单空）下停用一个 provider —— 必须展开成「其它 provider 的模型清单」；
 *   2. 停用 provider 时把它的单模型条目一起删掉，不能留下「关不干净」的残条。
 */
import { describe, expect, it } from "vitest";
import {
	enableAll,
	isModelEnabled,
	isProviderEnabled,
	toggleModel,
	toggleProvider,
} from "../../server/providers/enabled-models.js";

const universe = [
	{ provider: "a", models: ["m1", "m2"] },
	{ provider: "b", models: ["n1"] },
];

describe("isModelEnabled / isProviderEnabled", () => {
	it("白名单空 = 全开", () => {
		expect(isModelEnabled([], "a", "m1")).toBe(true);
		expect(isProviderEnabled([], "a")).toBe(true);
	});

	it("精确条目只放行那一个模型", () => {
		const patterns = ["a/m1"];
		expect(isModelEnabled(patterns, "a", "m1")).toBe(true);
		expect(isModelEnabled(patterns, "a", "m2")).toBe(false);
	});

	it("provider/** 放行该 provider 全部", () => {
		expect(isModelEnabled(["a/**"], "a", "任意")).toBe(true);
		expect(isProviderEnabled(["a/**"], "a")).toBe(true);
	});
});

describe("toggleProvider", () => {
	it("全开状态下停用 → 展开成其它 provider 的模型清单", () => {
		expect(toggleProvider([], "a", ["m1", "m2"], false, universe)).toEqual(["b/n1"]);
		expect(isProviderEnabled(["b/n1"], "a")).toBe(false);
		expect(isModelEnabled(["b/n1"], "b", "n1")).toBe(true);
	});

	it("停用会把该 provider 的单模型条目一起清掉", () => {
		expect(toggleProvider(["a/m1", "a/m2", "b/n1"], "a", ["m1", "m2"], false)).toEqual(["b/n1"]);
	});

	it("启用写 provider/**，并去掉重复的单模型条目", () => {
		expect(toggleProvider(["a/m1", "b/n1"], "a", ["m1"], true)).toEqual(["a/**", "b/n1"]);
	});
});

describe("toggleModel", () => {
	it("全开状态下关一个 → 展开成「其余模型」", () => {
		expect(toggleModel([], "a", ["m1", "m2"], "m1", false)).toEqual(["a/m2"]);
	});

	it("provider 全开时关一个 → 先把 /** 展开再删", () => {
		expect(toggleModel(["a/**", "b/n1"], "a", ["m1", "m2"], "m1", false)).toEqual(["a/m2", "b/n1"]);
	});

	it("开一个单模型", () => {
		expect(toggleModel(["b/n1"], "a", ["m1"], "m1", true)).toEqual(["a/m1", "b/n1"]);
	});
});

describe("enableAll", () => {
	it("清空白名单即全开", () => {
		expect(enableAll()).toEqual([]);
	});
});
