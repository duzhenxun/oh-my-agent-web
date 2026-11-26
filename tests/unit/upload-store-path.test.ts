/**
 * 上传副本的路径（用户 2026-11-26：「文件拖到对话框里，发送时没有发路径」）。
 *
 * 现场：`resolveAttachments()` 想要副本的绝对路径，但 store 上根本没有 `pathOf()`，
 * 于是回落到 `attachment.name` —— 模型收到的是「（附上文件，未注入内容：截图.png）」，
 * 一个没有目录的文件名。两处一起修：
 *   1. 落盘名带清洗过的原名（`<id>-截图.png`），路径本身能看懂、带扩展名；
 *   2. store 暴露 `pathOf(id)`；老的无后缀副本（`<id>`）照样读得回来。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createUploadStore } from "../../server/uploads/upload-store.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe("上传副本的路径", () => {
	let dataDir = "";

	before(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "aw-upload-path-"));
	});

	after(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("落盘名保留原名，pathOf 给出绝对路径", async () => {
		const store = createUploadStore({ dataDir });
		const saved = await store.save({ bytes: PNG, declaredMime: "image/png", name: "截图 1.png" });

		assert.equal(saved.name, "截图 1.png");
		assert.equal(basename(saved.path), `${saved.id}-截图_1.png`, "空白进文件名要换成下划线");

		const path = await store.pathOf(saved.id);
		assert.equal(path, saved.path);
		assert.ok(path !== null && isAbsolute(path), "必须是绝对路径，模型才读得到");
		assert.equal(dirname(path), join(dataDir, "uploads"));
		assert.ok(path.endsWith(".png"), "扩展名要在，模型才知道拿什么读");
	});

	it("文件名里的目录分隔符不会跑出上传目录", async () => {
		const store = createUploadStore({ dataDir });
		const saved = await store.save({ bytes: PNG, name: "../../etc/passwd" });
		const path = await store.pathOf(saved.id);
		assert.ok(path !== null);
		assert.equal(dirname(path), join(dataDir, "uploads"));
		assert.ok(!path.includes(".."), "清洗后不该留 ..");
	});

	it("read 能读回带原名的副本，也能读回老的无后缀副本", async () => {
		const store = createUploadStore({ dataDir });
		const saved = await store.save({ bytes: PNG, declaredMime: "image/png", name: "a.png" });
		const found = await store.read(saved.id);
		assert.ok(found !== null);
		assert.equal(found.mime, "image/png");

		// 存量：升级前落下的文件就是 `<id>`，没有任何后缀
		const legacyId = "0123456789abcdef";
		await writeFile(join(dataDir, "uploads", legacyId), PNG);
		const legacy = await store.read(legacyId);
		assert.ok(legacy !== null, "老副本升级后要还能读");
		assert.equal(await store.pathOf(legacyId), join(dataDir, "uploads", legacyId));
	});

	it("id 不安全或文件不存在时 pathOf 给 null，不抛", async () => {
		const store = createUploadStore({ dataDir });
		assert.equal(await store.pathOf("../etc/passwd"), null);
		assert.equal(await store.pathOf("deadbeefdeadbeef"), null);
	});
});
