/**
 * 附件上传的存储（ADR-0020 §P3）：限额、类型嗅探、id 安全、清理。
 * 用临时目录；顺带覆盖几个「不信任客户端」的关键点。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createUploadStore,
	isImageMime,
	isSafeUploadId,
	MAX_UPLOAD_BYTES,
	sniffMime,
	uploadsDir,
} from "../../server/uploads/upload-store.js";
import { decodeFileName } from "../../server/uploads/upload-routes.js";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-uploads-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("sniffMime（不信任客户端给的 content-type）", () => {
	it("认得出 png / jpeg / gif / webp", () => {
		expect(sniffMime(PNG_HEADER)).toBe("image/png");
		expect(sniffMime(JPEG_HEADER)).toBe("image/jpeg");
		expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
		const webp = new Uint8Array(12);
		webp.set([0x52, 0x49, 0x46, 0x46], 0);
		webp[8] = 0x57;
		expect(sniffMime(webp)).toBe("image/webp");
	});

	it("认不出的返回 null（调用方退回声明的类型）", () => {
		expect(sniffMime(new TextEncoder().encode("hello"))).toBeNull();
	});

	it("isImageMime 只看前缀", () => {
		expect(isImageMime("image/png")).toBe(true);
		expect(isImageMime("text/plain")).toBe(false);
	});
});

describe("isSafeUploadId（防目录穿越）", () => {
	it("只接受 [a-z0-9-] 且长度合理", () => {
		expect(isSafeUploadId("abc123def456")).toBe(true);
		expect(isSafeUploadId("../etc/passwd")).toBe(false);
		expect(isSafeUploadId("/etc/passwd")).toBe(false);
		expect(isSafeUploadId("ABC123")).toBe(false); // 大写不收
		expect(isSafeUploadId("short")).toBe(false); // 太短（不像我们生成的 id）
		expect(isSafeUploadId("")).toBe(false);
	});
});

describe("createUploadStore", () => {
	it("保存后能读回，类型按内容嗅探（忽略客户端声明）", async () => {
		const store = createUploadStore({ dataDir: dir });
		const saved = await store.save({ bytes: PNG_HEADER, declaredMime: "text/plain", name: "图.png" });
		expect(saved.mime).toBe("image/png"); // 声明是 text/plain，但内容是 PNG
		expect(saved.bytes).toBe(PNG_HEADER.byteLength);
		expect(saved.name).toBe("图.png");
		expect(existsSync(join(uploadsDir(dir), saved.id))).toBe(true);

		const read = await store.read(saved.id);
		expect(read?.mime).toBe("image/png");
		expect(read?.bytes.byteLength).toBe(PNG_HEADER.byteLength);
	});

	it("空文件与非图片（无魔术字节）走声明的类型", async () => {
		const store = createUploadStore({ dataDir: dir });
		await expect(store.save({ bytes: new Uint8Array() })).rejects.toThrow(/空文件/);
		const saved = await store.save({ bytes: new TextEncoder().encode("hello"), declaredMime: "text/markdown" });
		expect(saved.mime).toBe("text/markdown");
	});

	it("超过上限直接拒绝（10MB）", async () => {
		const store = createUploadStore({ dataDir: dir });
		const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
		await expect(store.save({ bytes: tooBig })).rejects.toThrow(/超过上限/);
	});

	it("读取不安全的 id 返回 null（不碰文件系统）", async () => {
		const store = createUploadStore({ dataDir: dir });
		expect(await store.read("../../etc/passwd")).toBeNull();
		expect(await store.read("不存在但合法id")).toBeNull();
	});

	it("清理：超过保留期的被删，新的留下", async () => {
		const now = Date.now();
		const store = createUploadStore({ dataDir: dir, now: () => now, ttlMs: 1000 });
		const oldOne = await store.save({ bytes: PNG_HEADER });
		const oldPath = join(uploadsDir(dir), oldOne.id);
		// 把 mtime 拨回 1 小时前
		const past = new Date(now - 60 * 60 * 1000);
		utimesSync(oldPath, past, past);
		const fresh = await store.save({ bytes: PNG_HEADER }); // 保存时会顺手清理

		expect(existsSync(oldPath)).toBe(false);
		expect(existsSync(join(uploadsDir(dir), fresh.id))).toBe(true);
	});

	it("上传目录不存在时清理不报错", async () => {
		const store = createUploadStore({ dataDir: join(dir, "不存在") });
		expect(await store.cleanup()).toBe(0);
	});

	it("落盘的就是原始字节（不加密不转码，读回一致）", async () => {
		const store = createUploadStore({ dataDir: dir });
		const bytes = new TextEncoder().encode("中文内容 with ascii");
		const saved = await store.save({ bytes, declaredMime: "text/plain" });
		expect(readFileSync(saved.path).toString("utf8")).toBe("中文内容 with ascii");
	});

	it("目录里已有的无关文件不受影响", async () => {
		writeFileSync(join(dir, "notes.txt"), "keep me", "utf8");
		const store = createUploadStore({ dataDir: dir, ttlMs: 0 });
		await store.save({ bytes: PNG_HEADER });
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
	});
});

describe("decodeFileName（请求头的两种编码都要伺候）", () => {
	it("百分号编码（我们前端发的）", () => {
		expect(decodeFileName(encodeURIComponent("截图 2026.png"))).toBe("截图 2026.png");
	});

	it("原样 UTF-8（curl 发的）也能解出来 —— Node 会按 latin1 解请求头", () => {
		const latin1 = Buffer.from("中文名.png", "utf8").toString("latin1");
		expect(decodeFileName(latin1)).toBe("中文名.png");
	});

	it("纯 ASCII 不受影响", () => {
		expect(decodeFileName("shot.png")).toBe("shot.png");
	});

	it("空头给默认名", () => {
		expect(decodeFileName("   ")).toBe("粘贴的图片");
	});

	it("乱糟糟的内容不至于变成乱码（转不出就原样返回）", () => {
		expect(decodeFileName("%E4%B8")).toContain("%E4%B8");
	});
});
