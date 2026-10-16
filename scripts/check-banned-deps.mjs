/**
 * 守卫 2：禁用依赖（ADR-0008）。
 *
 * 清单里的包一旦出现（生产或开发依赖都算）即视为违反 ADR-0008：
 * 组件库 / 状态管理库 / CSS 框架 / 路由 / i18n 框架 / 图标库 / 图表库 / 日期库。
 * 想用？先写新 ADR 推翻 ADR-0008 的那一条。
 */
import { readRepoFile, isMain, runGuard } from "./lib/guard-kit.mjs";

export const id = "banned-deps";
export const describe = "不含 ADR-0008 禁用清单里的依赖";

/** 精确名 */
export const BANNED_EXACT = new Set([
	"tailwindcss",
	"styled-components",
	"antd",
	"redux",
	"@reduxjs/toolkit",
	"zustand",
	"jotai",
	"recoil",
	"react-router",
	"react-router-dom",
	"wouter",
	"i18next",
	"react-i18next",
	"react-icons",
	"recharts",
	"chart.js",
	"echarts",
	"victory",
	"d3",
	"date-fns",
	"dayjs",
	"moment",
	"luxon",
	"lodash",
	"axios",
]);

/** 前缀（scope 类） */
export const BANNED_PREFIXES = ["@emotion/", "@mui/", "@chakra-ui/", "@heroicons/", "@ant-design/"];

export function isBanned(name) {
	return BANNED_EXACT.has(name) || BANNED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function inspect({ dependencies = {}, devDependencies = {} } = {}) {
	const violations = [];
	for (const [field, deps] of Object.entries({ dependencies, devDependencies })) {
		for (const name of Object.keys(deps ?? {})) {
			if (isBanned(name)) violations.push(`${field} 里出现禁用依赖：${name}（ADR-0008 禁清单）`);
		}
	}
	return violations;
}

export function collect() {
	const pkg = JSON.parse(readRepoFile("package.json"));
	return { dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };
}

export const selfTests = [
	{
		name: "干净依赖应通过",
		input: { dependencies: { ws: "8.0.0" }, devDependencies: { vitest: "3.0.0" } },
		shouldFail: false,
	},
	{ name: "tailwindcss 应变红", input: { devDependencies: { tailwindcss: "4.0.0" } }, shouldFail: true },
	{ name: "scoped 组件库应变红", input: { dependencies: { "@mui/material": "5.0.0" } }, shouldFail: true },
	{ name: "名字相近但不违规的包应通过", input: { dependencies: { "redux-lite-shim": "1.0.0" } }, shouldFail: false },
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
