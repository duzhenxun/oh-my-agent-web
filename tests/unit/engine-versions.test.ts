/**
 * 引擎版本号（切换面板每一行右上角那串 `v0.16.2`）。
 *
 * 要守住的四件事：
 *   1. 输出里挑版本号：`codex-cli 0.162.1` / `0.2.0-rc.2` / `v1.19.0` 都认，挑不出来就是 null；
 *   2. 不认 `--version` 的适配器（claude-code-acp）读 bin 旁边的 package.json；
 *   3. 探测不到**不编**：null 一路传下去，界面留空；
 *   4. 一次就够：结果（含 null）在本进程缓存，切引擎不会重新拉子进程；握手给的值更准、能盖上去。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseVersionText, probeCliVersion, probePackageVersion } from "../../server/engine/cli-version.ts";
import { createEngineVersionProber } from "../../server/engine/engine-versions.ts";
import type { EngineDescriptor } from "../../server/engine/registry.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "omaw-version-"));

const descriptor = (name: string, version: EngineDescriptor["version"]): EngineDescriptor => ({
	name,
	label: name,
	description: "",
	capabilities: { approvals: true, tools: true, modelSwitch: true, thinkingLevel: true, resume: true },
	create: () => {
		throw new Error("测试不走 create");
	},
	...(version ? { version } : {}),
});

describe("版本号的解析与探测", () => {
	it("从 CLI 输出里挑版本号（前缀名 / 预发布后缀 / v 前缀都能认）", () => {
		assert.equal(parseVersionText("codex-cli 0.162.1"), "0.162.1");
		assert.equal(parseVersionText("0.2.0-rc.2"), "0.2.0-rc.2");
		assert.equal(parseVersionText("v1.19.0\n"), "1.19.0");
		assert.equal(parseVersionText("claude-code-acp"), null);
		assert.equal(parseVersionText(""), null);
	});

	it("跑 <bin> --version 拿版本（stderr 里的也认）", async () => {
		const version = await probeCliVersion(process.execPath, {
			args: ["-e", "console.error('fake-cli 3.2.1')"],
		});
		assert.equal(version, "3.2.1");
	});

	it("没这个可执行文件 / 输出里没版本号 → null（不编）", async () => {
		assert.equal(await probeCliVersion("omaw-绝对没有这个命令", { timeoutMs: 500 }), null);
		assert.equal(await probeCliVersion(process.execPath, { args: ["-e", "console.log('hi')"] }), null);
	});

	it("ACP 适配器读 bin 旁边的 package.json（claude-code-acp 不认 --version）", () => {
		const root = tempDir();
		const pkg = join(root, "node_modules", "@zed-industries", "claude-code-acp");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "claude-code-acp", version: "0.16.2" }));
		const bin = join(pkg, "dist", "index.js");
		writeFileSync(bin, "#!/usr/bin/env node\n");
		assert.equal(probePackageVersion(bin, process.env), "0.16.2");
		// 没有任何 package.json → null
		assert.equal(probePackageVersion(join(root, "nowhere.js"), process.env), null);
	});
});

describe("引擎版本表（面板每一行各显各的）", () => {
	it("sync / async / 抛错混着来：探到的一起给，抛错的那个是 null", async () => {
		const prober = createEngineVersionProber({
			descriptors: () => [
				descriptor("pi", () => "1.4.0"),
				descriptor("codex", async () => "0.162.1"),
				descriptor("boom", async () => {
					throw new Error("没装");
				}),
				descriptor("nover", undefined),
			],
		});
		assert.deepEqual(await prober.refresh(), { pi: "1.4.0", codex: "0.162.1", boom: null, nover: null });
	});

	it("只探一次：第二次 refresh 不再调 version()", async () => {
		let calls = 0;
		const prober = createEngineVersionProber({
			descriptors: () => [
				descriptor("codex", async () => {
					calls += 1;
					return "0.162.1";
				}),
			],
		});
		await prober.refresh();
		await prober.refresh();
		await prober.refresh();
		assert.equal(calls, 1);
	});

	it("握手给的值更准：remember 之后不会被探测值盖掉（探测值本身可以是 null）", async () => {
		const prober = createEngineVersionProber({
			descriptors: () => [descriptor("claude", async () => null)],
		});
		prober.remember("claude", "0.16.2");
		assert.deepEqual(await prober.refresh(), { claude: "0.16.2" });
		assert.deepEqual(prober.known(), { claude: "0.16.2" });
	});
});
