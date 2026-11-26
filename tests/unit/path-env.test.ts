/**
 * PATH 拼接（`server/util/path-env.ts`）—— 引擎安装靠它把「用户装过的那颗引擎」挂回 PATH。
 *
 * 这一层的错法都很安静：拼错了不会崩，只会让界面说「没装」，而人明明刚装过。
 * 所以按纯函数逐个钉住（平台全部注入，测试不碰真实环境）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendToPath, pathSeparator, prependToPath } from "../../server/util/path-env.js";

describe("pathSeparator", () => {
	it("跟着目标平台走，不是跟着宿主", () => {
		assert.equal(pathSeparator("win32"), ";");
		assert.equal(pathSeparator("darwin"), ":");
		assert.equal(pathSeparator("linux"), ":");
	});
});

describe("prependToPath", () => {
	it("新目录在前、原有顺序保持不变", () => {
		assert.equal(prependToPath("/usr/bin:/bin", ["/opt/aw/bin"], "darwin"), "/opt/aw/bin:/usr/bin:/bin");
	});

	it("原本为空 / undefined 也不产出前导分隔符", () => {
		assert.equal(prependToPath("", ["/opt/aw/bin"], "darwin"), "/opt/aw/bin");
		assert.equal(prependToPath(undefined, ["/opt/aw/bin"], "darwin"), "/opt/aw/bin");
		assert.equal(prependToPath(":/usr/bin:", ["/opt/aw/bin"], "darwin"), "/opt/aw/bin:/usr/bin");
	});

	it("已经在 PATH 里的不重复加（幂等）", () => {
		const once = prependToPath("/usr/bin", ["/opt/aw/bin"], "darwin");
		const twice = prependToPath(once, ["/opt/aw/bin"], "darwin");
		assert.equal(twice, "/opt/aw/bin:/usr/bin");
	});

	it("Windows 大小写与斜杠方向都不敏感：同一个目录换写法不算新目录", () => {
		// 断言「只留一份」而不是具体拼写：两种写法谁是原样都无所谓，重复才是问题
		for (const existing of ["c:\\windows", "c:/WINDOWS/", "C:\\Windows\\"]) {
			const joined = prependToPath("C:\\Windows", [existing], "win32");
			assert.equal(joined.split(";").length, 1, `${existing} → ${joined}`);
		}
	});
});

describe("appendToPath", () => {
	it("追加到末尾：用户自己装的同名命令必须优先", () => {
		assert.equal(
			appendToPath("/opt/homebrew/bin:/usr/bin", ["/data/bin"], "darwin"),
			"/opt/homebrew/bin:/usr/bin:/data/bin",
		);
	});

	it("原本为空也不产出前导分隔符", () => {
		assert.equal(appendToPath("", ["/data/bin"], "darwin"), "/data/bin");
		assert.equal(appendToPath(undefined, ["/data/bin"], "darwin"), "/data/bin");
	});

	it("已经在 PATH 里的不重复加（幂等）", () => {
		const once = appendToPath("/usr/bin", ["/data/bin"], "darwin");
		assert.equal(appendToPath(once, ["/data/bin"], "darwin"), "/usr/bin:/data/bin");
	});

	it("Windows 上按 `;` 分隔并去重", () => {
		assert.equal(appendToPath("C:\\Windows;C:/windows/", ["C:\\data\\bin"], "win32"), "C:\\Windows;C:\\data\\bin");
	});
});
