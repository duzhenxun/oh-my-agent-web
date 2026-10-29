/**
 * 运行时瘦身：只留本平台的 node-pty 预编译产物（`server/util/prune-pty.ts`）。
 *
 * 这段逻辑以前是 `postinstall`，现在改成第一次启动时顺手做 —— 幂等性是它的核心契约：
 * 裁干净之后**再跑必须什么都不做**，否则每次启动都会多一条日志（还会反复 chmod）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { prunePtyPrebuilds } from "../../server/util/prune-pty.js";

const keep = `${process.platform}-${process.arch}`;
const roots: string[] = [];

function makeRoot(entries: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "aw-prune-"));
	roots.push(root);
	for (const entry of entries) mkdirSync(join(root, entry), { recursive: true });
	return root;
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("prunePtyPrebuilds", () => {
	it("只保留 <platform>-<arch>，别的平台目录全删掉", () => {
		const dir = makeRoot([keep, "win32-x64", "win32-arm64", "linux-x64"]);
		const result = prunePtyPrebuilds(dir);
		assert.equal(result?.keep, keep);
		assert.equal(result?.removed, 3);
		assert.deepEqual(readdirSync(dir), [keep]);
	});

	it("已经裁干净 → 返回 null（不再反复 chmod，也不该刷日志）", () => {
		const dir = makeRoot([keep]);
		assert.equal(prunePtyPrebuilds(dir), null);
	});

	it("prebuilds 目录不存在（node-pty 没装 / Linux 现场编译）→ 安全空转", () => {
		const root = makeRoot([]);
		assert.equal(prunePtyPrebuilds(join(root, "not-there")), null);
	});

	it("spawn-helper 缺可执行位时补成 0755，且只补一次", () => {
		const dir = makeRoot([keep]);
		const helper = join(dir, keep, "spawn-helper");
		writeFileSync(helper, "");
		if (process.platform !== "win32") chmodSync(helper, 0o644);

		const first = prunePtyPrebuilds(dir);
		if (process.platform !== "win32") {
			assert.equal(first?.fixedMode, true);
			assert.equal(statSync(helper).mode & 0o777, 0o755);
			assert.equal(prunePtyPrebuilds(dir), null, "第二次不该再报「修过权限」");
		} else {
			// Windows 上没有可执行位：不该声称自己修过
			assert.equal(first?.fixedMode, false);
		}
	});
});
