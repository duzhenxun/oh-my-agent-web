/**
 * 「新建项目」里手输 / 粘贴的目录路径（`server/util/paths.ts` 的 `normalizePathInput`）。
 *
 * 钉的是 Windows 上以前**静默失败**的三种输入：带引号的「复制文件地址」、只写了盘符的
 * `C:`、以及 `%USERPROFILE%` 这种环境变量 —— 服务端只认 `isAbsolute`，不认就回落成
 * 当前工作区，用户看到的是「按了跳转没反应」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePathInput } from "../../server/util/paths.ts";

describe("normalizePathInput", () => {
	it("剥掉「复制文件地址」带的那对引号", () => {
		assert.equal(normalizePathInput('"C:\\Users\\duzhe\\Desktop"'), "C:\\Users\\duzhe\\Desktop");
		assert.equal(normalizePathInput("'D:\\code'"), "D:\\code");
	});

	it("只写了盘符时补上根分隔符（`C:` 不是绝对路径）", () => {
		assert.equal(normalizePathInput("C:"), "C:\\");
		assert.equal(normalizePathInput("d:"), "d:\\");
	});

	it("展开 %VAR%（大小写都认），展开不了就留着原样", () => {
		assert.equal(normalizePathInput("%PROFILE%\\code", { PROFILE: "C:\\Users\\duzhe" }), "C:\\Users\\duzhe\\code");
		assert.equal(normalizePathInput("%profile%", { profile: "/home/duzhe" }), "/home/duzhe");
		assert.equal(normalizePathInput("%NOPE%\\x", {}), "%NOPE%\\x");
	});

	it("正常路径原样返回（不猜、不改写）", () => {
		assert.equal(normalizePathInput("  /Users/duzhe/code  "), "/Users/duzhe/code");
		assert.equal(normalizePathInput("C:/Users/duzhe"), "C:/Users/duzhe");
		assert.equal(normalizePathInput(""), "");
		// 只有一个引号：不是「整串被包着」，别把它当引号剥掉
		assert.equal(normalizePathInput('"C:\\Users'), '"C:\\Users');
	});
});
