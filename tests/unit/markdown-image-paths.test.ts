/**
 * 「模型只写了图片路径」→ 在对话里直接出图（`web/src/markdown-media.ts`）。
 *
 * 这一层是**文本层面的猜测**：猜对了用户直接看到图，猜错了（或文件根本不存在）界面会回落到
 * 可点的路径（Markdown.tsx 的 onError）。所以这里逐个钉住「哪种写法会被提升」，尤其是
 * **不该动**的那几种：代码块、远程 URL、非图片后缀、以及本来就正确的 `![]()`（重复包装会拼出畸形 markdown）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isImagePath, promoteImagePaths } from "../../web/src/markdown-media.ts";

describe("isImagePath", () => {
	it("认 绝对路径 / ~ / 相对文件名 / Windows 盘符，大小写不敏感", () => {
		assert.equal(isImagePath("/tmp/a.png"), true);
		assert.equal(isImagePath("~/Desktop/shot.JPG"), true);
		assert.equal(isImagePath("random_1.png"), true);
		assert.equal(isImagePath("C:\\shots\\a.webp"), true);
		assert.equal(isImagePath("./assets/a.svg"), true);
	});

	it("非图片后缀 / 带空格 / 空串都不算", () => {
		assert.equal(isImagePath("/tmp/a.txt"), false);
		assert.equal(isImagePath("README.md"), false);
		assert.equal(isImagePath("/tmp/my shot.png"), false);
		assert.equal(isImagePath("   "), false);
	});

	it("允许被尖括号或反引号包着（markdown 目的地 / 行内代码残留）", () => {
		assert.equal(isImagePath("</tmp/a.png>"), true);
		assert.equal(isImagePath("`/tmp/a.png`"), true);
	});
});

describe("promoteImagePaths", () => {
	it("裸路径（报告/列表里最常见的那种）直接变成图片", () => {
		assert.equal(
			promoteImagePaths("1. 随机几何色块：/Users/dds/data/ai/work/random_1.png"),
			"1. 随机几何色块：![random_1.png](</Users/dds/data/ai/work/random_1.png>)",
		);
	});

	it("行内代码整段是图片路径 → 图片（路径不留成代码）", () => {
		assert.equal(promoteImagePaths("保存为 `/tmp/a.png`"), "保存为 ![a.png](</tmp/a.png>)");
	});

	it("指向本地图片的链接 → 图片，链接文字当 alt", () => {
		assert.equal(promoteImagePaths("[截图](/tmp/shot.png)"), "![截图](</tmp/shot.png>)");
	});

	it("~ 与 Windows 盘符路径也认", () => {
		assert.equal(promoteImagePaths("见 ~/Desktop/a.png"), "见 ![a.png](<~/Desktop/a.png>)");
		assert.equal(promoteImagePaths("见 C:\\shots\\a.PNG"), "见 ![a.PNG](<C:\\shots\\a.PNG>)");
	});

	it("路径后面紧跟中文标点也能正确收尾", () => {
		assert.equal(promoteImagePaths("已生成 /tmp/a.png，还有别的"), "已生成 ![a.png](</tmp/a.png>)，还有别的");
	});

	it("本来就正确的 `![]()` 不要重复包装", () => {
		for (const text of ["![a](/tmp/a.png)", "![a](</tmp/a.png>)"]) {
			assert.equal(promoteImagePaths(text), text);
		}
	});

	it("远程图片 URL 不动（不是本地路径，也不该被截成半截）", () => {
		const text = "见 https://example.com/a.png 这张";
		assert.equal(promoteImagePaths(text), text);
	});

	it("非图片后缀不动", () => {
		for (const text of ["/tmp/a.txt", "见 docs/report.html", "`README.md`"]) {
			assert.equal(promoteImagePaths(text), text);
		}
	});

	it("代码块内的路径一律不动（那是代码/树，不是内容）", () => {
		const text = ["```text", "/tmp/a.png", "```", "/tmp/b.png"].join("\n");
		assert.equal(promoteImagePaths(text), ["```text", "/tmp/a.png", "```", "![b.png](</tmp/b.png>)"].join("\n"));
	});

	it("行内代码里如果只是「含」路径，不当成图", () => {
		const text = "`cp /tmp/a.png /tmp/b/`";
		assert.equal(promoteImagePaths(text), text);
	});

	it("斜杠紧贴字母（URL 中间段）不会被切成半截路径", () => {
		const text = "打开 https://example.com/files/a.png 看看";
		assert.equal(promoteImagePaths(text), text);
	});
});
