/**
 * 「新建项目」的目录浏览接口（`GET /api/fs/dirs`）。
 *
 * 钉的四件事：
 *   1. 只列**目录**，且只列一层（`node_modules`、隐藏目录按既有约定不列）；
 *   2. 目录符号链接（Windows 上是 junction）算可进入的目录 —— 只看 `isDirectory()`
 *      会把它们吞掉，而用户目录下最常用的跳转点恰好都是这种；
 *   3. 粘贴进来的「复制文件地址」（带引号）照样认；
 *   4. 显式给了非绝对路径要**说清楚**，不能静默回落成当前工作区（以前就是「按了没反应」）。
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { registerDirRoutes } from "../../server/files/dir-routes.ts";

type Body = {
	path?: string;
	parent?: string | null;
	entries?: { name: string; path: string }[];
	drives?: { name: string; path: string }[];
	error?: { code?: string; message?: string };
};

let root = "";
let base = "";
let server: import("node:http").Server;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "agent-web-dirs-"));
	await mkdir(join(root, "项目-a", "nested"), { recursive: true });
	await mkdir(join(root, "b-dir"));
	await mkdir(join(root, ".hidden"));
	await mkdir(join(root, "node_modules"));
	await mkdir(join(root, "target"));
	await writeFile(join(root, "README.md"), "hi\n");
	// 目录符号链接（Windows 上 dev 目录常见的就是 junction）
	await symlink(join(root, "target"), join(root, "link-to-dir"), "dir");

	const app = express();
	registerDirRoutes(app, { workspaceOf: () => root });
	server = app.listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	// macOS 上 /var 是 /private/var 的符号链接：接口回的就是 realpath 之后的形状，测试跟着它比
	root = realpathSync(root);
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(root, { recursive: true, force: true });
});

async function dirs(path?: string): Promise<{ status: number; body: Body }> {
	const url = path === undefined ? `${base}/api/fs/dirs` : `${base}/api/fs/dirs?path=${encodeURIComponent(path)}`;
	const response = await fetch(url);
	return { status: response.status, body: (await response.json()) as Body };
}

describe("GET /api/fs/dirs", () => {
	it("不给 path 时列当前工作区：只有目录，隐藏/依赖目录不出现", async () => {
		const { status, body } = await dirs();
		assert.equal(status, 200);
		assert.deepEqual(
			body.entries?.map((entry) => entry.name),
			// `target` / `node_modules` / `.hidden` 按既有约定不列（IGNORED_ENTRIES + 点号开头）
			["b-dir", "link-to-dir", "项目-a"].sort((a, b) => a.localeCompare(b)),
		);
		assert.equal(
			body.entries?.some((entry) => entry.name === "README.md"),
			false,
		);
	});

	it("符号链接指向目录时算可进入", async () => {
		const { body } = await dirs();
		assert.ok(body.entries?.some((entry) => entry.name === "link-to-dir"));
	});

	it("带引号的粘贴路径也能打开，返回的是归一化后的真实路径", async () => {
		const quoted = `"${join(root, "项目-a")}"`;
		const { status, body } = await dirs(quoted);
		assert.equal(status, 200);
		assert.equal(body.path, join(root, "项目-a"));
		assert.equal(body.parent, root);
		assert.deepEqual(
			body.entries?.map((entry) => entry.name),
			["nested"],
		);
	});

	it("显式给了非绝对路径：400 说人话，不静默回落到工作区", async () => {
		const { status, body } = await dirs("target/nested");
		assert.equal(status, 400);
		assert.equal(body.error?.code, "fs.not_absolute");
	});

	it("路径不存在 / 不是目录：400", async () => {
		assert.equal((await dirs(join(root, "nope"))).status, 400);
		assert.equal((await dirs(join(root, "README.md"))).status, 400);
	});

	it("盘符列表是非 Windows 平台上的空数组（Windows 才有切盘那一行）", async () => {
		const { body } = await dirs();
		assert.deepEqual(body.drives, process.platform === "win32" ? body.drives : []);
	});
});
