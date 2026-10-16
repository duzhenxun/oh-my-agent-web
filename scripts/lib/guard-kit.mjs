/**
 * 守卫脚本工具箱（ADR-0009）。
 *
 * 约定：每个守卫脚本导出同一组东西，并可在两种模式下运行：
 *   - 真实模式（默认）：`node scripts/check-xxx.mjs` —— 扫描仓库，有违规就退出码 1；
 *   - 自检模式：`--self-test` —— 用内置的正/反样例证明 inspect() 真的能变红。
 *
 * 「守卫必须能失败」是元纪律（ADR-0009）：没有自检的守卫等于没有守卫。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** 递归列出仓库内相对路径（相对 REPO_ROOT，统一用 `/`） */
export function walk(relDir, extensions) {
	const out = [];
	const walkInto = (rel) => {
		const abs = join(REPO_ROOT, rel);
		let entries;
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walkInto(child);
			else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(child);
		}
	};
	walkInto(relDir);
	return out.sort();
}

export function readRepoFile(rel) {
	return readFileSync(join(REPO_ROOT, rel), "utf8");
}

export function repoFileOrNull(rel) {
	return existsSync(join(REPO_ROOT, rel)) ? readRepoFile(rel) : null;
}

export function countLines(text) {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/** 当前模块是不是被 `node xxx.mjs` 直接执行的 */
export function isMain(metaUrl) {
	const entry = process.argv[1];
	return Boolean(entry) && pathToFileURL(entry).href === metaUrl;
}

/**
 * 运行一个守卫。mod 形状：{ id, describe, inspect, collect, selfTests }
 * selfTests: [{ name, input, shouldFail }]
 */
export function runGuard(mod) {
	if (process.argv.includes("--self-test")) {
		const failed = [];
		for (const test of mod.selfTests ?? []) {
			const violations = mod.inspect(test.input);
			const didFail = violations.length > 0;
			if (didFail !== test.shouldFail) {
				failed.push(`  ✗ ${test.name}：期望${test.shouldFail ? "变红" : "通过"}，实际${didFail ? "变红" : "通过"}`);
			}
		}
		if (failed.length > 0) {
			console.error(`❌ ${mod.id} 自检失败（守卫本身不可信）：`);
			console.error(failed.join("\n"));
			process.exit(1);
		}
		console.log(`✅ ${mod.id} 自检通过（${(mod.selfTests ?? []).length} 例）`);
		return;
	}

	let violations;
	try {
		violations = mod.inspect(mod.collect());
	} catch (error) {
		console.error(`❌ ${mod.id} 执行失败：${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (violations.length > 0) {
		console.error(`❌ ${mod.id} — ${mod.describe}`);
		for (const violation of violations) console.error(`  · ${violation}`);
		process.exit(1);
	}
	console.log(`✅ ${mod.id} — ${mod.describe}`);
}
