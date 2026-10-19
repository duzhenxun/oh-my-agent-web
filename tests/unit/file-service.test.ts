/**
 * 文件浏览与只读预览（M4）：懒加载列目录、路径约束、二进制与截断。
 * 用临时目录（真实文件系统），重点盯「不许看到工作区外面」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listDirectory,
	looksBinary,
	MAX_PREVIEW_BYTES,
	readPreview,
	sortEntries,
} from "../../server/files/file-service.js";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agent-web-files-"));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "README.md"), "# hello\n", "utf8");
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
	writeFileSync(join(root, ".secret"), "nope", "utf8");
	writeFileSync(join(root, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("sortEntries", () => {
	it("目录优先，同类按名字", () => {
		const sorted = sortEntries([
			{ name: "b.ts", path: "b.ts", isDir: false },
			{ name: "z-dir", path: "z-dir", isDir: true },
			{ name: "a.ts", path: "a.ts", isDir: false },
			{ name: "a-dir", path: "a-dir", isDir: true },
		]);
		expect(sorted.map((entry) => entry.name)).toEqual(["a-dir", "z-dir", "a.ts", "b.ts"]);
	});
});

describe("listDirectory（懒加载一层）", () => {
	it("列出根目录：目录在前、隐藏文件被过滤", async () => {
		const result = await listDirectory(root, "");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries.map((entry) => entry.name)).toEqual(["docs", "src", "logo.png", "README.md"]);
		expect(result.entries.some((entry) => entry.name === ".secret")).toBe(false);
	});

	it("列出子目录只给一层，子路径相对根", async () => {
		const result = await listDirectory(root, "src");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
	});

	it("越界路径被拒（ADR-0006）", async () => {
		const outside = await listDirectory(root, "../");
		expect(outside.ok).toBe(false);
		if (!outside.ok) expect(outside.error).toContain("越界");
	});

	it("不存在的目录给出可读错误", async () => {
		const result = await listDirectory(root, "不存在");
		expect(result.ok).toBe(false);
	});
});

describe("readPreview（只读、有上限）", () => {
	it("文本文件原样读出", async () => {
		const result = await readPreview(root, "README.md");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("# hello\n");
		expect(result.binary).toBe(false);
		expect(result.truncated).toBe(false);
	});

	it("二进制文件不给内容（只给标记）", async () => {
		const result = await readPreview(root, "logo.png");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.binary).toBe(true);
		expect(result.text).toBe("");
	});

	it("超大文件被截断并标记", async () => {
		writeFileSync(join(root, "big.txt"), "x".repeat(MAX_PREVIEW_BYTES + 10), "utf8");
		const result = await readPreview(root, "big.txt");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(MAX_PREVIEW_BYTES);
	});

	it("目录不能当文件预览", async () => {
		const result = await readPreview(root, "src");
		expect(result.ok).toBe(false);
	});

	it("越界路径被拒", async () => {
		expect((await readPreview(root, "../package.json")).ok).toBe(false);
	});
});

describe("looksBinary", () => {
	it("NUL 字节与常见二进制扩展名判为二进制", () => {
		expect(looksBinary(new Uint8Array([1, 2, 0, 3]), "a.bin")).toBe(true);
		expect(looksBinary(new TextEncoder().encode("hi"), "photo.png")).toBe(true);
		expect(looksBinary(new TextEncoder().encode("hi"), "a.ts")).toBe(false);
	});
});

describe("忽略清单（依赖与构建产物不占满文件树）", () => {
	it("node_modules / dist 不列出来", async () => {
		mkdirSync(join(root, "node_modules"));
		mkdirSync(join(root, "dist"));
		const result = await listDirectory(root, "");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries.some((entry) => entry.name === "node_modules" || entry.name === "dist")).toBe(false);
	});
});
