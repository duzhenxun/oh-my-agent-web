/**
 * 文件树的纯逻辑（`web/src/file-tree-model.ts`）里「定位一个文件」那两个函数。
 *
 * 背景：树是懒加载的，默认只列第一层。用户点内容搜索 / 文件搜索里的某一行时，
 * 左边那棵树必须**一层层展开**到那个文件并把它选上 —— 展开哪几层由 `ancestorDirs` 决定，
 * 而文件不在左树当前根下面时，`nextTreeRoot` 决定要不要把根切过去。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorDirs, hiddenAncestor, nextTreeRoot } from "../../web/src/file-tree-model.ts";

describe("ancestorDirs", () => {
	it("顶层文件不需要展开任何目录", () => {
		assert.deepEqual(ancestorDirs("README.md"), []);
	});

	it("一层层给全，外层在前（按顺序展开才对得上）", () => {
		assert.deepEqual(ancestorDirs("web/src/components/FileTree.tsx"), ["web", "web/src", "web/src/components"]);
	});

	it("多深就展开多深（没有层数上限）", () => {
		assert.equal(ancestorDirs("a/b/c/d/e/f.txt").length, 5);
	});

	it("前后多写的斜杠不影响", () => {
		assert.deepEqual(ancestorDirs("/docs/guide.md"), ["docs"]);
	});
});

describe("nextTreeRoot", () => {
	const root = "/p/app";

	it("文件就在当前根下面 → 不动（保持「跟随当前会话」的 null）", () => {
		assert.equal(nextTreeRoot(null, root, root), null);
		assert.equal(nextTreeRoot(root, root, root), root);
	});

	it("文件在别的项目 → 根切到那个项目，否则它根本不在那棵树里", () => {
		assert.equal(nextTreeRoot(null, root, "/p/other"), "/p/other");
		assert.equal(nextTreeRoot("/p/third", root, "/p/other"), "/p/other");
	});

	it("下拉框已经被手动选成别的项目、但这个文件属于会话工作区 → 仍按“当前根”比，切过去", () => {
		// current 是 /p/third，文件在 /p/app：切到 /p/app（不是保持 /p/third）
		assert.equal(nextTreeRoot("/p/third", root, root), root);
	});

	it('空串（还没打开会话）当「没有根」处理，回 null 而不是 ""', () => {
		assert.equal(nextTreeRoot(null, null, ""), null);
	});
});

describe("hiddenAncestor", () => {
	it("祖先里有「.」开头的目录就报出来（树默认不列，得先把眼睛打开）", () => {
		assert.equal(hiddenAncestor(".playwright-cli/page-1.yml"), ".playwright-cli");
		assert.equal(hiddenAncestor(".github/workflows/ci.yml"), ".github");
	});

	it("藏在普通目录里面的隐藏目录也认", () => {
		assert.equal(hiddenAncestor("web/.next/cache/x.js"), "web/.next");
	});

	it("没有隐藏目录 → null（正常定位，不用动设置）", () => {
		assert.equal(hiddenAncestor("web/src/components/FileTree.tsx"), null);
		assert.equal(hiddenAncestor("README.md"), null);
	});
});
