import { describe, expect, it } from "vitest";
import { makeIdFactory, shortId } from "../../server/util/ids.js";

describe("id 生成（ADR-0019：跨进程唯一）", () => {
	it("连续生成不重复", () => {
		const ids = new Set(Array.from({ length: 2000 }, () => shortId()));
		expect(ids.size).toBe(2000);
	});

	it("带前缀，且同一前缀下也不重复", () => {
		const next = makeIdFactory();
		const ids = new Set(Array.from({ length: 500 }, () => next("conv")));
		expect(ids.size).toBe(500);
		for (const id of ids) expect(id.startsWith("conv-")).toBe(true);
	});

	it("两个独立工厂（模拟两次启动）产出不同 id —— 这正是之前踩的坑", () => {
		const runA = makeIdFactory();
		const runB = makeIdFactory();
		const fromA = new Set(Array.from({ length: 200 }, () => runA("conv")));
		for (const id of Array.from({ length: 200 }, () => runB("conv"))) expect(fromA.has(id)).toBe(false);
	});
});
