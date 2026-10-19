/**
 * 项目排序（ADR-0028）：置顶优先、显式顺序、新项目落最上面。
 */
import { describe, expect, it } from "vitest";
import { moveProject, sortProjects } from "../../web/src/project-sort.ts";

const p = (cwd: string, startedAt: number) => ({ cwd, sessions: [{ startedAt }] });
const projects = [p("/a", 100), p("/b", 300), p("/c", 200)];

describe("sortProjects", () => {
	it("没有偏好时：按最新会话创建时间倒序", () => {
		expect(sortProjects(projects, { order: [], pinned: [], aliases: {} }).map((x) => x.cwd)).toEqual([
			"/b",
			"/c",
			"/a",
		]);
	});

	it("置顶段在最上，且按 pinned 数组顺序", () => {
		const sorted = sortProjects(projects, { order: [], pinned: ["/a", "/c"], aliases: {} });
		expect(sorted.slice(0, 2).map((x) => x.cwd)).toEqual(["/a", "/c"]);
	});

	it("显式顺序生效；**新项目插到未置顶段最上面**（即使已拖过顺序）", () => {
		const prefs = { order: ["/c", "/a"], pinned: [], aliases: {} };
		// /b 不在 order 里 = 新项目 → 排最前；其余按 order
		expect(sortProjects(projects, prefs).map((x) => x.cwd)).toEqual(["/b", "/c", "/a"]);
	});

	it("置顶与顺序解耦：取消置顶后回到它原本的相对位置", () => {
		const prefs = { order: ["/c", "/a"], pinned: ["/a"], aliases: {} };
		const withPin = sortProjects(projects, prefs).map((x) => x.cwd);
		const withoutPin = sortProjects(projects, { ...prefs, pinned: [] }).map((x) => x.cwd);
		expect(withPin[0]).toBe("/a");
		expect(withoutPin.slice(-2)).toEqual(["/c", "/a"]); // /a 回到 order 里的位置
	});
});

describe("moveProject", () => {
	it("把项目移动到指定索引", () => {
		expect(moveProject([], projects, "/a", 2)).toEqual(["/b", "/c", "/a"]);
		expect(moveProject([], projects, "/c", 0)).toEqual(["/c", "/a", "/b"]);
	});

	it("越界索引被夹住", () => {
		expect(moveProject([], projects, "/a", 99)).toEqual(["/b", "/c", "/a"]);
	});
});
