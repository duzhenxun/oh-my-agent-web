import { defineConfig } from "vitest/config";

/**
 * 第 1 层测试：纯函数单测（ADR-0009）。
 * 毫秒级、零 token、零端口 —— CI 必跑。
 * 需要起进程/端口的冒烟测试放在 tests/smoke/，由 tests/smoke/run.mjs 聚合跑。
 */
export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		silent: true,
		// M0 阶段用例数量可能为 0；不允许「没有用例」变成失败（ADR-0009 的 DoD）
		passWithNoTests: true,
		onConsoleLog: () => false,
	},
});
