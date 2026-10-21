/**
 * 项目顺序稳定性（ADR-0028 §3 的回归网）：
 * 侧栏顺序必须**只**由 (prefs, 项目集合, 会话创建时间) 决定 —— 与输入顺序、
 * 重复渲染次数无关；「跑一轮对话 / 切会话 / 扫描顺序抖动」都不许让项目自己乱跳。
 */
import { describe, expect, it } from "vitest";
import { moveProject, sortProjects } from "../../web/src/project-sort.ts";
import type { ProjectPrefs } from "../../web/src/types.ts";

type P = { cwd: string; sessions: { startedAt: number }[] };
const p = (cwd: string, ...startedAt: number[]): P => ({
	cwd,
	sessions: startedAt.map((t) => ({ startedAt: t })),
});
const prefs = (order: string[] = [], pinned: string[] = []): ProjectPrefs => ({ order, pinned, aliases: {} });
const cwds = (list: P[]): string[] => list.map((x) => x.cwd);

/** 确定性洗牌（不用 Math.random：同一颗种子永远同一个排列，失败可复现） */
function shuffle<T>(items: T[], seed: number): T[] {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

describe("顺序稳定性：与输入顺序无关", () => {
	it("同一批项目，任意输入排列给出同一个结果（含 pinned + order + 新项目三段）", () => {
		const projects = [p("/a", 100), p("/b", 300), p("/c", 200), p("/d", 400), p("/e", 500)];
		const preferences = prefs(["/c", "/a", "/d"], ["/e"]);
		const expected = cwds(sortProjects(projects, preferences));
		for (let seed = 1; seed <= 24; seed += 1) {
			expect(cwds(sortProjects(shuffle(projects, seed), preferences))).toEqual(expected);
		}
	});

	it("200 个项目 × 8 次洗牌：结果逐位相同", () => {
		const many = Array.from({ length: 200 }, (_, i) => p(`/p${String(i).padStart(3, "0")}`, (i * 7919) % 5000));
		const preferences = prefs([], ["/p100", "/p000"]);
		const expected = cwds(sortProjects(many, preferences));
		for (let seed = 1; seed <= 8; seed += 1) {
			expect(cwds(sortProjects(shuffle(many, seed), preferences))).toEqual(expected);
		}
	});

	it("重复渲染是幂等的：sort(sort(x)) 与 sort(x) 完全一致", () => {
		const projects = [p("/a", 100), p("/b", 300), p("/c", 200)];
		const preferences = prefs(["/a"], ["/b"]);
		const once = sortProjects(projects, preferences);
		expect(cwds(sortProjects(once, preferences))).toEqual(cwds(once));
		expect(cwds(sortProjects(sortProjects(once, preferences), preferences))).toEqual(cwds(once));
	});

	it("会话创建时间打平时按 cwd 兜底：结果确定且不随输入顺序变", () => {
		const projects = [p("/x", 42), p("/y", 42), p("/z", 42)];
		expect(cwds(sortProjects(projects, prefs()))).toEqual(["/x", "/y", "/z"]);
		expect(cwds(sortProjects([...projects].reverse(), prefs()))).toEqual(["/x", "/y", "/z"]);
	});
});

describe("顺序稳定性：新增活动不推动已有项目", () => {
	it("已拖过顺序的项目：新会话不会把它顶上去", () => {
		const before = [p("/a", 100), p("/b", 200)];
		const preferences = prefs(["/b", "/a"]);
		expect(cwds(sortProjects(before, preferences))).toEqual(["/b", "/a"]);
		// /a 里又开了一轮（新会话创建时间更新）：显式顺序优先，位置不变
		const after = [p("/a", 100, 999), p("/b", 200)];
		expect(cwds(sortProjects(after, preferences))).toEqual(["/b", "/a"]);
	});

	it("置顶段完全不受未置顶段变化影响", () => {
		const preferences = prefs(["/a"], ["/pin1", "/pin2"]);
		const before = [p("/pin1", 1), p("/pin2", 2), p("/a", 3), p("/new", 4)];
		const after = [p("/pin1", 1), p("/pin2", 2), p("/a", 3, 900), p("/new", 4, 999), p("/newer", 1000)];
		expect(cwds(sortProjects(before, preferences)).slice(0, 2)).toEqual(["/pin1", "/pin2"]);
		expect(cwds(sortProjects(after, preferences)).slice(0, 2)).toEqual(["/pin1", "/pin2"]);
	});
});

describe("顺序稳定性：偏好里的脏数据不破坏其余顺序", () => {
	it("order 里的失效 cwd（目录已删）被忽略，剩余项目相对顺序不变", () => {
		const projects = [p("/a", 1), p("/b", 2), p("/c", 3)];
		const clean = cwds(sortProjects(projects, prefs(["/c", "/b", "/a"])));
		const stale = cwds(sortProjects(projects, prefs(["/gone", "/c", "/gone2", "/b", "/a"])));
		expect(clean).toEqual(["/c", "/b", "/a"]);
		expect(stale).toEqual(clean);
	});

	it("order / pinned 里重复的 cwd 按**首次出现**定位（与服务端归一化一致）", () => {
		const projects = [p("/a", 1), p("/b", 2)];
		expect(cwds(sortProjects(projects, prefs(["/a", "/b", "/a"])))).toEqual(["/a", "/b"]);
		expect(cwds(sortProjects(projects, prefs([], ["/b", "/a", "/b"])))).toEqual(["/b", "/a"]);
	});

	it("project 同时出现在 pinned 与 order 时只出现在置顶段一次", () => {
		const projects = [p("/a", 1), p("/b", 2), p("/c", 3)];
		const sorted = cwds(sortProjects(projects, prefs(["/a", "/b", "/c"], ["/c"])));
		expect(sorted).toEqual(["/c", "/a", "/b"]);
		expect(new Set(sorted).size).toBe(sorted.length);
	});
});

describe("顺序稳定性：拖动写回的往返", () => {
	it("按当前显示顺序拖动 → 写回 order → 再排序是原样（松手不会跳回去）", () => {
		const projects = [p("/a", 300), p("/b", 100), p("/c", 200)];
		const shown = cwds(sortProjects(projects, prefs())); // /a /c /b
		// 展示顺序即 moveProject 的输入顺序
		const displayed = shown.map((cwd) => projects.find((x) => x.cwd === cwd) as P);
		const written = moveProject([], displayed, "/b", 0);
		expect(written).toEqual(["/b", "/a", "/c"]);
		// 写回之后（全部变成"已知项目"）不允许再按创建时间重排
		expect(cwds(sortProjects(projects, prefs(written)))).toEqual(written);
	});

	it("移动不增删项目：任何索引都只做置换", () => {
		const projects = [p("/a", 1), p("/b", 2), p("/c", 3), p("/d", 4)];
		for (const from of ["/a", "/b", "/c", "/d"]) {
			for (const to of [-3, 0, 1, 2, 3, 99]) {
				const out = moveProject([], projects, from, to);
				expect([...out].sort()).toEqual(["/a", "/b", "/c", "/d"]);
				expect(out[Math.max(0, Math.min(to, 3))]).toBe(from);
			}
		}
	});
});
