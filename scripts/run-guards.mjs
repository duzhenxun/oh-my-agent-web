/**
 * 守卫聚合跑器（ADR-0009）。
 *
 * 用法：
 *   node scripts/run-guards.mjs              # 真实模式：扫仓库，任一失败即退出码 1
 *   node scripts/run-guards.mjs --self-test  # 自检模式：证明每个守卫真的能变红
 *
 * 每个守卫也可以单独跑：node scripts/check-deps.mjs
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/guard-kit.mjs";

const GUARDS = [
	"check-deps.mjs",
	"check-banned-deps.mjs",
	"check-engine-imports.mjs",
	"check-file-size.mjs",
	"check-protocol-sync.mjs",
];

const selfTest = process.argv.includes("--self-test");
const args = selfTest ? ["--self-test"] : [];

console.log(`\n${selfTest ? "守卫自检（每个守卫都必须能变红）" : "守卫检查"}：${GUARDS.length} 个\n`);

let failed = 0;
for (const guard of GUARDS) {
	const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", guard), ...args], {
		stdio: "inherit",
		cwd: REPO_ROOT,
	});
	if (result.status !== 0) failed += 1;
}

console.log("");
if (failed > 0) {
	console.error(`❌ 守卫${selfTest ? "自检" : "检查"}失败：${failed}/${GUARDS.length}\n`);
	process.exit(1);
}
console.log(`✅ 全部通过：${GUARDS.length}/${GUARDS.length}\n`);
