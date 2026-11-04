/**
 * 「隐藏项目」的拆分（侧栏右键菜单 → 隐藏项目背后的纯函数）。
 *
 * 钉住三件事：
 *   1. 藏起来的项目从侧栏那一列里消失，别的顺序不变（取消隐藏就回原位）；
 *   2. 旧数据里带尾斜杠的 cwd 也算同一个项目（`/a/b/` 与 `/a/b`）——
 *      不归一化的话「隐藏了却还在」「根本没藏过却不见了」都会出现；
 *   3. 被藏的项目仍然被返回（底部「已隐藏 · N」入口要靠它才能点开）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitHiddenProjects } from "../../web/src/project-hide.ts";

const projects = [{ cwd: "/a" }, { cwd: "/b" }, { cwd: "/c" }];

test("一个都没藏：原样返回，隐藏清单为空", () => {
	const { visible, hidden } = splitHiddenProjects(projects, []);
	assert.deepEqual(visible, projects);
	assert.deepEqual(hidden, []);
});

test("藏中间那个：它从列表里消失，但还留在隐藏清单里", () => {
	const { visible, hidden } = splitHiddenProjects(projects, ["/b"]);
	assert.deepEqual(
		visible.map((project) => project.cwd),
		["/a", "/c"],
	);
	assert.deepEqual(
		hidden.map((project) => project.cwd),
		["/b"],
	);
});

test("尾斜杠 / 空串的脏数据按同一个项目算", () => {
	const { visible, hidden } = splitHiddenProjects(projects, ["/b/"]);
	assert.deepEqual(
		visible.map((project) => project.cwd),
		["/a", "/c"],
	);
	assert.equal(hidden.length, 1);
});

test("藏一个不存在的 cwd：谁都不受影响", () => {
	const { visible, hidden } = splitHiddenProjects(projects, ["/nope", ""]);
	assert.equal(visible.length, 3);
	assert.equal(hidden.length, 0);
});
