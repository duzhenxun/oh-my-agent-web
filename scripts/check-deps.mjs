/**
 * 守卫 1：生产依赖预算（ADR-0008）。
 *
 * `dependencies`（生产依赖）条目数硬上限 12；`devDependencies` 不计入。
 * 超限说明有人忘了「每新增一个生产依赖都要在 CONTEXT.md 记一行理由」这条规则，
 * 正确做法是先看 ADR-0008 的初始清单里有没有空位，再决定要不要改 ADR。
 */
import { readRepoFile, isMain, runGuard } from "./lib/guard-kit.mjs";

export const id = "deps-budget";
export const describe = `生产依赖不超过 ${12} 个（ADR-0008）`;
export const LIMIT = 12;

export function inspect({ dependencies = {} } = {}) {
	const names = Object.keys(dependencies ?? {});
	if (names.length <= LIMIT) return [];
	return [
		`生产依赖 ${names.length} 个 > 上限 ${LIMIT} 个：${names.join(", ")}`,
		"新增生产依赖前请先看 ADR-0008（初始清单/禁清单/每项都要有理由）",
	];
}

export function collect() {
	const pkg = JSON.parse(readRepoFile("package.json"));
	return { dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };
}

export const selfTests = [
	{
		name: `正好 ${LIMIT} 个生产依赖应通过`,
		input: { dependencies: Object.fromEntries(Array.from({ length: LIMIT }, (_, i) => [`dep-${i}`, "1.0.0"])) },
		shouldFail: false,
	},
	{
		name: `第 ${LIMIT + 1} 个生产依赖应变红`,
		input: { dependencies: Object.fromEntries(Array.from({ length: LIMIT + 1 }, (_, i) => [`dep-${i}`, "1.0.0"])) },
		shouldFail: true,
	},
	{
		name: "devDependencies 不计入额度",
		input: {
			dependencies: { "dep-0": "1.0.0" },
			devDependencies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`dev-${i}`, "1.0.0"])),
		},
		shouldFail: false,
	},
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
