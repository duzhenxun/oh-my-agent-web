/**
 * 会话搬家（move-session 的文件层）：重写 header 的 cwd + 搬到新项目的会话目录。
 *
 * 这是拖拽「把会话拖到另一个项目」最危险的一步 —— 直接改 pi 的会话文件。
 * 断言三件事：header 的 cwd 真的改了、id/历史原样保留、旧文件被归档而不是留下两份能扫到的会话。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { encodeSessionCwdDir, moveSessionFile, parseSessionHeader } from "../../server/session/pi-sessions.js";

function makeSession(root: string, cwd: string, name = "sess.jsonl"): string {
	const dir = join(root, encodeSessionCwdDir(cwd));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	const header = { type: "session", version: 3, id: "abc123", timestamp: "2026-01-01T00:00:00.000Z", cwd };
	const body =
		'{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n';
	writeFileSync(file, `${JSON.stringify(header)}\n${body}`);
	return file;
}

describe("会话搬家（文件层）", () => {
	it("encodeSessionCwdDir 与 SDK 同款编码：去掉首斜杠、把 / 与 : 换成 -，两端包 --", () => {
		assert.equal(encodeSessionCwdDir("/a/b"), "--a-b--");
		assert.equal(encodeSessionCwdDir("/data/ai/my-skills"), "--data-ai-my-skills--");
		assert.equal(encodeSessionCwdDir("/Users/dds/.agents"), "--Users-dds-.agents--");
	});

	it("moveSessionFile：改 cwd、保 id 与历史、旧文件归档到 .moved-*", async () => {
		const root = mkdtempSync(join(tmpdir(), "oms-move-"));
		const source = makeSession(root, "/old/proj");

		const target = await moveSessionFile(root, source, "/new/proj");

		// 新文件落在新项目的会话目录里
		assert.equal(target, join(root, "--new-proj--", "sess.jsonl"));
		const raw = readFileSync(target, "utf8");
		const header = parseSessionHeader(raw.split("\n")[0]);
		assert.equal(header?.cwd, "/new/proj");
		assert.equal(header?.id, "abc123");
		assert.ok(raw.includes("hello"), "正文（历史）必须原样保留");

		// 旧文件不在了（归档成 .moved-*，扫描器按 .jsonl 结尾过滤，不会重复出现）
		const oldDir = readdirSync(join(root, "--old-proj--"));
		assert.equal(oldDir.filter((name) => name.endsWith(".jsonl")).length, 0);
		assert.equal(
			oldDir.some((name) => name.endsWith(".moved-") || name.includes(".moved-")),
			true,
		);
	});
});
