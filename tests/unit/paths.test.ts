/**
 * 路径约束（`server/util/paths.ts`）。
 *
 * 这一层是文件 / 终端 / 上传的**公共入口**：`resolveInsideRoot` 判错就等于把整个磁盘交出去。
 * 注释里说「刻意把 realpath 注入，单测不需要造文件系统」—— 之前没人写，现在补上。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import {
	checkWindowsPath,
	isEscapePath,
	isPathInside,
	pickExisting,
	resolveInsideRoot,
	toPosixPath,
} from "../../server/util/paths.js";

describe("checkWindowsPath", () => {
	it("POSIX 上永远放行（不是 win32 就什么都不检查）", () => {
		assert.equal(checkWindowsPath("nul", "linux"), null);
		assert.equal(checkWindowsPath("a:b:c", "darwin"), null);
	});
	it("Windows 保留设备名（带扩展名也算）", () => {
		assert.match(checkWindowsPath("C:\\tmp\\NUL", "win32") ?? "", /保留设备名/);
		assert.match(checkWindowsPath("C:\\tmp\\nul.txt", "win32") ?? "", /保留设备名/);
		assert.match(checkWindowsPath("C:\\tmp\\COM1", "win32") ?? "", /保留设备名/);
	});
	it("Windows 非法字符", () => {
		assert.match(checkWindowsPath("C:\\tmp\\a|b", "win32") ?? "", /不允许的字符/);
		assert.match(checkWindowsPath("C:\\tmp\\a?b", "win32") ?? "", /不允许的字符/);
	});
	it("以点或空格结尾", () => {
		assert.match(checkWindowsPath("C:\\tmp\\foo.", "win32") ?? "", /空格或点结尾/);
		assert.match(checkWindowsPath("C:\\tmp\\foo ", "win32") ?? "", /空格或点结尾/);
	});
	it("超长路径", () => {
		assert.match(checkWindowsPath(`C:\\${"a".repeat(300)}`, "win32") ?? "", /路径太长/);
	});
	it("正常路径与盘符冒号放行", () => {
		assert.equal(checkWindowsPath("C:\\Users\\dds\\proj\\src\\index.ts", "win32"), null);
		assert.equal(checkWindowsPath("C:\\tmp\\a-b_c(1).ts", "win32"), null);
	});
});

describe("isPathInside", () => {
	const root = resolve("/root");
	it("根本身算在里面", () => {
		assert.equal(isPathInside(root, resolve("/root")), true);
	});
	it("子路径算在里面", () => {
		assert.equal(isPathInside(root, resolve("/root/a/b.ts")), true);
	});
	it("前缀相同的兄弟目录**不**算（startsWith 的经典坑）", () => {
		assert.equal(isPathInside(root, resolve("/root2/a.ts")), false);
	});
	it(".. 逃逸不算", () => {
		assert.equal(isPathInside(root, resolve("/root/../etc/passwd")), false);
	});
	it('名字以 .. 开头的**合法**条目算在里面（旧写法 startsWith("..") 会误杀）', () => {
		// 文件树里真能建出来这种名字；以前读取时报「路径越界」，但列表里看得见
		assert.equal(isPathInside(root, resolve("/root/..foo")), true);
		assert.equal(isPathInside(root, resolve("/root/...cache/a.ts")), true);
		// 而真逃逸必须带分隔符
		assert.equal(isEscapePath(".."), true);
		assert.equal(isEscapePath("../etc"), true);
		assert.equal(isEscapePath("..foo"), false);
	});
});

describe("resolveInsideRoot", () => {
	const fakeRealpath = (path: string) => path;
	it("根内的路径放行并返回真实路径", () => {
		const result = resolveInsideRoot("/root", "/root/a/index.ts", fakeRealpath);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.path, resolve("/root/a/index.ts"));
	});
	it("根外拒绝", () => {
		const result = resolveInsideRoot("/root", "/etc/passwd", fakeRealpath);
		assert.equal(result.ok, false);
	});
	it("realpath 抛错 → 拒绝（宁可拒绝也不要放行）", () => {
		const result = resolveInsideRoot("/root", "/root/a", () => {
			throw new Error("ENOENT");
		});
		assert.equal(result.ok, false);
	});
	it("symlink 逃逸：realpath 把路径解析到根外 → 拒绝", () => {
		const result = resolveInsideRoot("/root", "/root/link", (path) => (path.endsWith("link") ? "/etc" : path));
		assert.equal(result.ok, false);
	});
});

describe("pickExisting / toPosixPath", () => {
	it("取第一个存在的候选", () => {
		assert.equal(
			pickExisting(["a", "b", "c"], (path) => path === "b"),
			"b",
		);
		assert.equal(
			pickExisting(["a"], () => false),
			null,
		);
	});
	it("把分隔符统一成 /", () => {
		assert.equal(toPosixPath("src/app/page.tsx"), "src/app/page.tsx");
	});
});
