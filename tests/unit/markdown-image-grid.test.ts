/**
 * 多张图的段落合并（`groupImageBlocks`）：并排渲染的前置条件。
 *
 * 渲染层只能把**同一个段落**里的图放进 flex 容器并排，所以「每张图一行、中间空行」的常见写法
 * 必须先并成一段。这里钉住三件事：① 该并的要并；② 文字与图混排的不能并（否则文字被挤进图格）；
 * ③ 代码块里的图片语法一律不动（那是代码，不是内容）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePathOnce, groupImageBlocks, imageSrcOf, promoteImagePaths } from "../../web/src/markdown-media.ts";

describe("groupImageBlocks", () => {
	it("空行分隔的多张图并成一段（并补一个空行，避免和下文粘连）", () => {
		const input = "![a](</x/1.png>)\n\n![b](</x/2.png>)\n\n后面是正文";
		assert.equal(groupImageBlocks(input), "![a](</x/1.png>)\n![b](</x/2.png>)\n\n后面是正文");
	});

	it("紧邻多行（本来就同一段）保持原样，不重复插空行", () => {
		const input = "![a](</x/1.png>)\n![b](</x/2.png>)";
		assert.equal(groupImageBlocks(input), "![a](</x/1.png>)\n![b](</x/2.png>)");
	});

	it("一张图一个段落：不合并、不加空行", () => {
		const input = "![a](</x/1.png>)\n\n正文";
		assert.equal(groupImageBlocks(input), "![a](</x/1.png>)\n\n正文");
	});

	it("文字与图混排的行不合并（否则文字会被挤进图格）", () => {
		const input = "看图：![a](</x/1.png>)\n\n![b](</x/2.png>)";
		assert.equal(groupImageBlocks(input), "看图：![a](</x/1.png>)\n\n![b](</x/2.png>)");
	});

	it("列表项 / 引用里的图不动（前缀不匹配，合并会破坏结构）", () => {
		const input = "- ![a](</x/1.png>)\n- ![b](</x/2.png>)";
		assert.equal(groupImageBlocks(input), input);
		const quote = "> ![a](</x/1.png>)\n\n> ![b](</x/2.png>)";
		assert.equal(groupImageBlocks(quote), quote);
	});

	it("代码块里的图片语法一律不动", () => {
		const input = "```\n![a](</x/1.png>)\n\n![b](</x/2.png>)\n```";
		assert.equal(groupImageBlocks(input), input);
	});

	it("没有图片的文本原样返回（同一个引用，memo 可直接跳过）", () => {
		const input = "只有正文，没有任何图片";
		assert.equal(groupImageBlocks(input), input);
	});

	it("和 promoteImagePaths 串起来：裸路径也会被并成一组", () => {
		const input = "/x/1.png\n\n/x/2.png";
		assert.equal(groupImageBlocks(promoteImagePaths(input)), "![1.png](</x/1.png>)\n![2.png](</x/2.png>)");
	});
});

describe("decodePathOnce / 表格不提升", () => {
	it("解析器编码过的路径解回中文", () => {
		const encoded = encodeURIComponent("映客活动数据/测试/四象凌霄-mobile.png");
		assert.equal(decodePathOnce(encoded), "映客活动数据/测试/四象凌霄-mobile.png");
	});

	it("本来没有编码的路径原样返回（同一个引用语义）", () => {
		assert.equal(decodePathOnce("docs/a.png"), "docs/a.png");
	});

	it("非法编码串不会抛错", () => {
		assert.equal(decodePathOnce("100%/a.png"), "100%/a.png");
	});

	it("imageSrcOf 不会对已编码的 src 二次编码（双重编码 → 路径不存在）", () => {
		const encoded = encodeURIComponent("映客活动数据/四象凌霄-desktop.png");
		const src = imageSrcOf(encoded);
		assert.equal(src?.includes("%25"), false);
		assert.equal(decodeURIComponent(String(src).split("path=")[1]!), "映客活动数据/四象凌霄-desktop.png");
	});

	it("表格行里的行内代码图片路径不提升（不拆坏表格）", () => {
		const row = "| `映客活动数据/测试/...四象凌霄-desktop.png` | 1440×900 |";
		assert.equal(promoteImagePaths(row), row);
	});

	it("表格行之外照样提升", () => {
		assert.equal(promoteImagePaths("`/out/a.png`"), "![a.png](</out/a.png>)");
	});
});
