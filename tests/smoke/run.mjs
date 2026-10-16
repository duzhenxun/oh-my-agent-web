/**
 * 冒烟测试聚合跑器（ADR-0009 第 2 层）。
 *
 * 每个用例文件是自包含的：自己起服务（临时数据目录 + 端口 ≥8900）、自己清理。
 * 这里只负责：构建一次（若需要）→ 顺序/并行跑 → 汇总 → 以退出码表达结果。
 *
 * 用法：
 *   node tests/smoke/run.mjs              # 全量
 *   node tests/smoke/run.mjs --core       # 只跑 CORE 子集（快检）
 *   node tests/smoke/run.mjs --no-build   # 跳过套件前的构建（dist/ 已就绪）
 *   node tests/smoke/run.mjs send-message # 只跑指定用例
 *
 * M0 状态：用例数量为 0，跑器本身可用（先跑出第一个绿）。
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

/** CORE = 协议/快照/安全/审批代表用例，用于 PR 快检（ADR-0009 分层） */
const CORE = ["flow"];

const argv = process.argv.slice(2);
const useCore = argv.includes("--core");
const noBuild = argv.includes("--no-build");
const only = argv.filter((arg) => !arg.startsWith("--"));

function discover() {
	return readdirSync(HERE)
		.filter((name) => name.endsWith("-smoke.mjs"))
		.map((name) => ({ name: name.replace(/-smoke\.mjs$/, ""), file: join(HERE, name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function run(caseFile) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [caseFile], { cwd: REPO_ROOT, stdio: "inherit" });
		child.on("exit", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}

async function main() {
	const all = discover();
	let cases = useCore ? all.filter((item) => CORE.includes(item.name)) : all;
	if (only.length > 0) cases = cases.filter((item) => only.includes(item.name));

	console.log(`\n冒烟测试：${cases.length} 个用例${useCore ? "（--core）" : ""}${noBuild ? "（--no-build）" : ""}\n`);
	if (!noBuild) {
		// M0 之前没有需要构建的产物；M1 起这里接「串行构建一次」（避免并行下互相踩 dist/）。
		console.log("（构建步骤：待 M1 接入）");
	}

	const failed = [];
	for (const item of cases) {
		process.stdout.write(`▶ ${item.name} … `);
		const code = await run(item.file);
		if (code === 0) console.log("ok");
		else {
			console.log(`失败（code=${code}）`);
			failed.push(item.name);
		}
	}

	console.log("");
	if (failed.length > 0) {
		console.error(`❌ 失败 ${failed.length}/${cases.length}：${failed.join(", ")}\n`);
		process.exit(1);
	}
	console.log(`✅ 全部通过：${cases.length}/${cases.length}\n`);
}

await main();
