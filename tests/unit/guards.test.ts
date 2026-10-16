/**
 * 守卫的元测试（ADR-0009 元纪律：守卫必须能失败）。
 *
 * 两类断言：
 *   1. 每个守卫都声明了 selfTests（没有自检的守卫等于没有守卫）；
 *   2. 用真实仓库状态跑一遍 collect() + inspect()，必须通过 ——
 *      这样「有人偷偷加了第 13 个依赖」会同时在守卫与单测里变红。
 */
import { describe, expect, it } from "vitest";
import * as bannedDeps from "../../scripts/check-banned-deps.mjs";
import * as depsBudget from "../../scripts/check-deps.mjs";
import * as engineImports from "../../scripts/check-engine-imports.mjs";
import * as fileSize from "../../scripts/check-file-size.mjs";
import * as protocolSync from "../../scripts/check-protocol-sync.mjs";

/**
 * 守卫模块结构各不相同（每个有自己的输入形状），测试里只关心这四项。
 * 用显式断言绕过联合类型在 inspect 参数上的逆变检查。
 */
type AnyGuard = {
	id: string;
	inspect: (input: any) => string[];
	collect: () => any;
	selfTests: Array<{ name: string; input: any; shouldFail: boolean }>;
};

const asGuard = (mod: unknown) => mod as AnyGuard;

const GUARDS = [
	asGuard(depsBudget),
	asGuard(bannedDeps),
	asGuard(engineImports),
	asGuard(fileSize),
	asGuard(protocolSync),
];

describe("守卫必须能失败（元纪律）", () => {
	for (const guard of GUARDS) {
		it(`${guard.id} 声明了自检样例，且每条样例的期望都被 inspect 满足`, () => {
			expect(guard.selfTests.length).toBeGreaterThan(0);
			for (const test of guard.selfTests) {
				const didFail = guard.inspect(test.input).length > 0;
				expect(didFail, `样例「${test.name}」期望${test.shouldFail ? "变红" : "通过"}`).toBe(test.shouldFail);
			}
		});
	}
});

describe("当前仓库必须通过全部守卫", () => {
	for (const guard of GUARDS) {
		it(`${guard.id} 在本仓库上无违规`, () => {
			expect(guard.inspect(guard.collect())).toEqual([]);
		});
	}
});
