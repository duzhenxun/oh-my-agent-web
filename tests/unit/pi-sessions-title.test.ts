/**
 * 侧栏会话标题的扫描（`scanPiSessions`）：**首条消息很长时也不能丢标题**。
 *
 * 用户报的 bug：新建会话发第一条消息（带截图）之后，顶栏标题是那句话，
 * 左侧项目下那一行却是「2026/10/28 16:57:51」—— 一个时间戳。
 *
 * 根因：粘贴的截图是**内联 base64 存在同一条消息里的**，首条用户消息那一行能有几百 KB，
 * 而读文件头部只有 256KB 预算；老实现会在行中间截断 → `JSON.parse` 必失败 →
 * 这条会话被当成「没有标题」，退化成文件修改时间。
 *
 * 这里用一条真实形状的文件（首行 header + 一条 600KB 的 user 消息）把它钉住：
 * 预算之外要**把这一行读完**，标题必须读得出来。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { encodeSessionCwdDir, scanPiSessions } from "../../server/session/pi-sessions.js";

/** 造一条会话文件：header + 可选的超长首条 user 消息（内联 base64 图片，跟粘贴截图一致） */
function makeSessionFile(
	root: string,
	cwd: string,
	options: { id: string; text?: string; imageBytes?: number } = { id: "abc123" },
): string {
	const dir = join(root, encodeSessionCwdDir(cwd));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-01T00-00-00-000Z_${options.id}.jsonl`);
	const header = { type: "session", version: 3, id: options.id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
	const lines = [JSON.stringify(header)];
	if (options.text !== undefined) {
		const parts: Array<Record<string, unknown>> = [{ type: "text", text: options.text }];
		if (options.imageBytes) {
			// base64 体积 = 原始字节数 / 3 * 4，凑够「一行远超头部预算」就行
			parts.push({ type: "image", mimeType: "image/png", data: "A".repeat(options.imageBytes) });
		}
		lines.push(JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: parts } }));
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

describe("侧栏会话标题扫描", () => {
	it("首条消息带内联图片（一行 600KB）时标题仍读得出来，不会退化成时间戳", async () => {
		const root = mkdtempSync(join(tmpdir(), "oms-title-"));
		const text = "新会话时,把这 2 块移动到上面的那个模型的左边";
		makeSessionFile(root, "/work/proj", { id: "big-line", text, imageBytes: 600_000 });

		const result = await scanPiSessions({ sessionsRoot: root });

		assert.equal(result.total, 1);
		const session = result.groups[0]?.sessions[0];
		assert.ok(session, "应该扫到一条会话");
		assert.equal(session.id, "big-line");
		assert.equal(session.title, text);
		assert.ok(!/^\d{4}\/\d{1,2}\/\d{1,2}/.test(session.title), "不能退化成时间戳兜底名");
	});

	it("普通会话照旧：取首条 user 消息，折叠换行并截到 60 字", async () => {
		const root = mkdtempSync(join(tmpdir(), "oms-title-plain-"));
		makeSessionFile(root, "/work/proj", { id: "plain", text: "第一行\n第二行" });

		const result = await scanPiSessions({ sessionsRoot: root });

		assert.equal(result.groups[0]?.sessions[0]?.title, "第一行 第二行");
	});

	it("空会话（还没发消息）仍用文件修改时间兜底：不留一个空标题", async () => {
		const root = mkdtempSync(join(tmpdir(), "oms-title-empty-"));
		makeSessionFile(root, "/work/proj", { id: "empty" });

		const result = await scanPiSessions({ sessionsRoot: root });

		const title = result.groups[0]?.sessions[0]?.title ?? "";
		assert.match(title, /^\d{4}\/\d{1,2}\/\d{1,2}/);
	});
});
