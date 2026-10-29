/**
 * 拖动改项目顺序（侧栏那个手势背后的纯函数）。
 *
 * 要有它是因为这段逻辑同时碰三样东西：**当前看到的顺序**、置顶段、以及 `sortProjects`
 * 那条「pinned 永远在最上面」的规矩 —— 只改 order 数组的话，跨段一拖就会在松手瞬间被排回原位
 * （用户看到的就是「拖了没反应」）。所以这里把「拖进置顶段 = 顺便置顶」这条也钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reorderProjects } from "../../web/src/project-sort.ts";

const visible = ["/a", "/b", "/c", "/d"];

test("同段内往下拖：插到目标后面", () => {
	assert.deepEqual(reorderProjects({ visible, pinned: [], from: "/a", target: "/c", after: true }), {
		pinned: [],
		order: ["/b", "/c", "/a", "/d"],
	});
});

test("同段内往上拖：插到目标前面（下标按摘掉被拖项之后算，不会偏一格）", () => {
	assert.deepEqual(reorderProjects({ visible, pinned: [], from: "/d", target: "/b", after: false }), {
		pinned: [],
		order: ["/a", "/d", "/b", "/c"],
	});
});

test("拖到列表末尾之后：夹在最后，不越界", () => {
	assert.deepEqual(reorderProjects({ visible, pinned: [], from: "/a", target: "/d", after: true }), {
		pinned: [],
		order: ["/b", "/c", "/d", "/a"],
	});
});

test("拖进置顶段 = 顺便置顶（否则松手就被排回下面）", () => {
	assert.deepEqual(reorderProjects({ visible, pinned: ["/a"], from: "/c", target: "/a", after: true }), {
		pinned: ["/a", "/c"],
		order: ["/b", "/d"],
	});
});

test("从置顶段拖回下面段 = 取消置顶", () => {
	assert.deepEqual(reorderProjects({ visible, pinned: ["/a", "/b"], from: "/b", target: "/d", after: false }), {
		pinned: ["/a"],
		order: ["/c", "/b", "/d"],
	});
});

test("拖到自己身上 / 目标不在列表里：什么都不动", () => {
	assert.equal(reorderProjects({ visible, pinned: [], from: "/a", target: "/a", after: true }), null);
	assert.equal(reorderProjects({ visible, pinned: [], from: "/a", target: "/zzz", after: false }), null);
	assert.equal(reorderProjects({ visible, pinned: [], from: "/zzz", target: "/a", after: false }), null);
});
