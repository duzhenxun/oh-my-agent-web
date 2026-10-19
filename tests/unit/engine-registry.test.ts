/**
 * 引擎注册表（ADR-0024 §1/§2）：
 *  - 加引擎不该改 runtime / 前端；未知名字**回落**而不是崩；
 *  - 能力矩阵要如实传下去（界面据此显隐）。
 */
import { describe, expect, it } from "vitest";
import {
	createEngineRegistry,
	FAKE_CAPABILITIES,
	PI_CAPABILITIES,
	type EngineDescriptor,
} from "../../server/engine/registry.js";
import type { EnginePort } from "../../server/engine/port.js";

const stub = (tag: string) => ({ tag }) as unknown as EnginePort;

function makeRegistry() {
	const descriptors: EngineDescriptor[] = [
		{ name: "pi", label: "pi", capabilities: PI_CAPABILITIES, create: () => stub("pi") },
		{ name: "fake", label: "假引擎", capabilities: FAKE_CAPABILITIES, create: () => stub("fake") },
		{
			name: "codex",
			label: "Codex CLI",
			capabilities: { ...PI_CAPABILITIES, approvals: false },
			create: () => stub("codex"),
		},
	];
	return createEngineRegistry(descriptors);
}

describe("引擎注册表", () => {
	it("列出已注册的引擎名", () => {
		expect(makeRegistry().names()).toEqual(["pi", "fake", "codex"]);
	});

	it("按名字取引擎", () => {
		const resolved = makeRegistry().resolve("codex");
		expect((resolved.engine as unknown as { tag: string }).tag).toBe("codex");
		expect(resolved.fallbackFrom).toBeNull();
	});

	it("未知名字回落到 pi，并报告回落的来源", () => {
		const resolved = makeRegistry().resolve("gemini-cli");
		expect((resolved.engine as unknown as { tag: string }).tag).toBe("pi");
		expect(resolved.descriptor.name).toBe("pi");
		expect(resolved.fallbackFrom).toBe("gemini-cli");
	});

	it("能力矩阵如实返回（没有审批就是没有）", () => {
		const registry = makeRegistry();
		expect(registry.capabilitiesOf("codex").approvals).toBe(false);
		expect(registry.capabilitiesOf("pi").approvals).toBe(true);
		expect(registry.capabilitiesOf("不存在").approvals).toBe(true); // 回落 pi
	});

	it("注册表为空时直接报错（不留一个没有引擎的进程）", () => {
		expect(() => createEngineRegistry([])).toThrow();
	});
});
