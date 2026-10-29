/**
 * 全文搜索（`server/files/content-search.ts`）。
 *
 * 两层：glob 匹配与长行裁剪是纯函数（好测、也没有文件系统依赖）；
 * searchFileContents 用临时目录造一棵小树，验证「跳过的目录 / 二进制 / 符号链接」这些边界 ——
 * 这些边界不测，一次搜索就会把 node_modules 全读一遍。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	GREP_LINE_CHARS,
	globToRegExp,
	lineWindow,
	matchesGlob,
	searchFileContents,
} from "../../server/files/content-search.js";

describe("globToRegExp / matchesGlob", () => {
	it("空模式 = 不筛", () => {
		assert.equal(globToRegExp(""), null);
		assert.equal(matchesGlob("src/a.ts", ""), true);
		assert.equal(matchesGlob("src/a.ts", "   "), true);
	});

	it("`*.ts` 只看文件名（任意目录下的 ts 都算）", () => {
		assert.equal(matchesGlob("src/a.ts", "*.ts"), true);
		assert.equal(matchesGlob("a.ts", "*.ts"), true);
		assert.equal(matchesGlob("src/a.tsx", "*.ts"), false);
		assert.equal(matchesGlob("src/a.go", "*.ts"), false);
	});

	it("带 `/` 的模式匹配整条相对路径，`**` 跨目录", () => {
		assert.equal(matchesGlob("src/web/a.ts", "src/*.ts"), false);
		assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
		assert.equal(matchesGlob("src/web/deep/a.ts", "src/**/*.ts"), true);
		assert.equal(matchesGlob("src/a.ts", "src/**/*.ts"), true);
		assert.equal(matchesGlob("test/a.ts", "src/**/*.ts"), false);
	});

	it("没有通配符的纯词按「包含」处理", () => {
		assert.equal(matchesGlob("src/tsconfig.json", "tsconfig"), true);
		assert.equal(matchesGlob("src/a.go", "tsconfig"), false);
	});

	it("`?` 只吃一个字符，正则特殊字符按字面", () => {
		assert.equal(matchesGlob("a1.ts", "a?.ts"), true);
		assert.equal(matchesGlob("a12.ts", "a?.ts"), false);
		assert.equal(matchesGlob("a.b.ts", "a.b.ts"), true);
		assert.equal(matchesGlob("axb.ts", "a.b.ts"), false);
	});
});

describe("lineWindow", () => {
	it("短行原样返回，列号就是命中位置", () => {
		const { text, column } = lineWindow('  const name = "最好的我们";', 15);
		assert.equal(text, '  const name = "最好的我们";');
		assert.equal(column, 15);
	});

	it("去掉行尾空白", () => {
		assert.equal(lineWindow("abc   ", 0).text, "abc");
	});

	it("超长行取命中附近的一段，列号跟着平移", () => {
		const raw = `${"x".repeat(3000)}needle${"y".repeat(3000)}`;
		const at = raw.indexOf("needle");
		const { text, column } = lineWindow(raw, at);
		assert.equal(text.length, GREP_LINE_CHARS);
		assert.equal(text.slice(column, column + 6), "needle");
		assert.ok(text.length <= GREP_LINE_CHARS);
	});
});

describe("searchFileContents", () => {
	/** 造一棵小树：tmp/src/a.ts、tmp/src/b.go、tmp/node_modules/x.ts、tmp/bin.dat（二进制） */
	const makeTree = async () => {
		const root = await mkdtemp(join(tmpdir(), "omaw-grep-"));
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(root, "src", "a.ts"), 'const a = 1;\nconst needle = "最好的我们";\nneedle again\n');
		await writeFile(join(root, "src", "b.go"), "package main\n// needle 在 go 里\n");
		await writeFile(join(root, "node_modules", "pkg", "x.ts"), "needle inside node_modules\n");
		await writeFile(join(root, "bin.dat"), Buffer.from([0x6e, 0x65, 0x00, 0x65]));
		return root;
	};

	it("命中每一行，路径是相对 posix，行号从 1 起", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "needle");
			assert.equal(result.ok, true);
			if (!result.ok) return;
			const hits = result.matches.map((match) => `${match.path}:${match.line}`);
			assert.deepEqual(hits, ["src/a.ts:2", "src/a.ts:3", "src/b.go:2"]);
			assert.equal(result.matches[0].column, 6);
			assert.match(result.matches[0].text, /最好的我们/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("跳过 node_modules（IGNORED_ENTRIES）和二进制文件", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "needle");
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(
				result.matches.some((match) => match.path.includes("node_modules")),
				false,
			);
			assert.equal(
				result.matches.some((match) => match.path === "bin.dat"),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("glob 过滤只留匹配的文件", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "needle", { glob: "*.go" });
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.deepEqual(
				result.matches.map((match) => match.path),
				["src/b.go"],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("大小写不敏感", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "NEEDLE");
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(result.matches.length, 3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("空关键字不扫盘", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "   ");
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(result.matches.length, 0);
			assert.equal(result.files, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("结果数到上限就截断（truncated）", async () => {
		const root = await makeTree();
		try {
			const result = await searchFileContents(root, "needle", { maxResults: 1 });
			assert.equal(result.ok, true);
			if (!result.ok) return;
			assert.equal(result.matches.length, 1);
			assert.equal(result.truncated, true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("不跟符号链接（防成环）", async () => {
		const root = await mkdtemp(join(tmpdir(), "omaw-grep-link-"));
		try {
			await mkdir(join(root, "real"), { recursive: true });
			await writeFile(join(root, "real", "a.ts"), "needle\n");
			await symlink(join(root, "real"), join(root, "loop"));
			const result = await searchFileContents(root, "needle");
			assert.equal(result.ok, true);
			if (!result.ok) return;
			// 真实文件一次，链接那次不跟
			assert.deepEqual(
				result.matches.map((match) => match.path),
				["real/a.ts"],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
