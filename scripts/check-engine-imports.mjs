/**
 * 守卫 3：引擎导入边界（ADR-0003）。
 *
 * **只有 `server/engine/` 下的文件可以 import 引擎 SDK**（pi SDK 及其关联类型）。
 * 业务代码一律只见「引擎端口」自己定义的类型；越过这条线，将来换引擎就是重写。
 */
import { isMain, readRepoFile, runGuard, walk } from "./lib/guard-kit.mjs";

export const id = "engine-imports";
export const describe = "除 server/engine/ 外没有任何文件 import 引擎 SDK（ADR-0003）";
export const ALLOWED_DIR = "server/engine/";
export const SDK_PREFIXES = ["@earendil-works/", "typebox"];

const IMPORT_RE =
	/(?:from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\))/g;

export function isSdkSpecifier(specifier) {
	return SDK_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix));
}

/** input: { files: [{ path, text }] } */
export function inspect({ files = [] } = {}) {
	const violations = [];
	for (const file of files) {
		if (file.path.startsWith(ALLOWED_DIR)) continue;
		for (const match of file.text.matchAll(IMPORT_RE)) {
			const specifier = match[1] ?? match[2] ?? match[3];
			if (isSdkSpecifier(specifier)) {
				violations.push(`${file.path} 直接 import 了 ${specifier}（只允许 ${ALLOWED_DIR}* 这么做）`);
			}
		}
	}
	return violations;
}

/**
 * 守卫脚本自身的自检样例里含有被禁的字符串（这是它们的职责），扫描时跳过守卫脚本本身。
 * 注意：这意味着「往守卫脚本里写 SDK import」不会被这条守卫拦住 —— 可接受（并已记录在 ROADMAP M0 的实际发现里）。
 */
const GUARD_SELF_RE = /^scripts\/check-[a-z-]+\.mjs$/;

export function collect() {
	const paths = [
		...walk("server", [".ts"]),
		...walk("web/src", [".ts", ".tsx"]),
		...walk("tests", [".ts", ".mjs"]),
		...walk("scripts", [".mjs"]),
	].filter((path) => !GUARD_SELF_RE.test(path));
	return { files: paths.map((path) => ({ path, text: readRepoFile(path) })) };
}

export const selfTests = [
	{
		name: "业务文件 import SDK 应变红",
		input: {
			files: [{ path: "server/session/store.ts", text: 'import { Agent } from "@earendil-works/pi-coding-agent";' }],
		},
		shouldFail: true,
	},
	{
		name: "server/engine/ 内 import SDK 应通过",
		input: {
			files: [{ path: "server/engine/pi-sdk.ts", text: 'import { Agent } from "@earendil-works/pi-coding-agent";' }],
		},
		shouldFail: false,
	},
	{
		name: "动态 import / require 也要拦",
		input: {
			files: [
				{ path: "server/util/x.ts", text: 'const m = await import("typebox");' },
				{ path: "server/util/y.mjs", text: 'const t = require("typebox");' },
			],
		},
		shouldFail: true,
	},
	{
		name: "普通第三方包不算越界",
		input: { files: [{ path: "server/index.ts", text: 'import express from "express";' }] },
		shouldFail: false,
	},
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
