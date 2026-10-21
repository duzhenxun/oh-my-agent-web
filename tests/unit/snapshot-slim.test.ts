/**
 * 会话清单的「按需发送」（快照瘦身）。
 *
 * 起因很具体：手机上切会话要 1.8s，而快照里 70% 是那一份几乎不变的 pi 会话清单
 * （实测 153KB 里 118KB 是它，272 个会话）。现在只对**明确说自己受得了**的客户端
 * （SSE 上带 slim=1）在「第一次 / 版本变了 / 隔了 30s」时才带。
 *
 * 两条不能破的性质：
 *   1. 老客户端（不带 slim 标记）永远每帧都收到 —— 否则它的侧栏会变空；
 *   2. 丢了一帧也能自己长回来（30s 兜底重发）。
 */
import { describe, expect, it } from "vitest";
import { buildSnapshot, createServerState, setPiProjects } from "../../server/snapshot/state.js";
import { createClientView, PROJECTS_RESEND_MS } from "../../server/session/client-view.js";

const project = (cwd: string, sessionId: string) => ({
	cwd,
	name: cwd,
	sessions: [
		{
			id: sessionId,
			title: "会话",
			startedAt: 1,
			updatedAt: 2,
			cwd,
			model: null,
			sessionPath: `/p/${sessionId}.jsonl`,
		},
	],
});

describe("clientView.needsProjects", () => {
	it("老客户端（没标记 slim）一直带", () => {
		const view = createClientView();
		expect(view.needsProjects("tab-old", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-old", 1, 1000)).toBe(true);
	});

	it("slim 客户端：第一次带，同一版本不再带", () => {
		const view = createClientView();
		view.setSlim("tab-a", true);
		expect(view.needsProjects("tab-a", 7, 0)).toBe(true);
		expect(view.needsProjects("tab-a", 7, 1000)).toBe(false);
		expect(view.needsProjects("tab-a", 7, 2000)).toBe(false);
	});

	it("清单版本变了要重新带", () => {
		const view = createClientView();
		view.setSlim("tab-a", true);
		expect(view.needsProjects("tab-a", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-a", 2, 100)).toBe(true);
		expect(view.needsProjects("tab-a", 2, 200)).toBe(false);
	});

	it("隔了 30s 兜底重发（丢帧能自己长回来）", () => {
		const view = createClientView();
		view.setSlim("tab-a", true);
		expect(view.needsProjects("tab-a", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-a", 1, PROJECTS_RESEND_MS - 1)).toBe(false);
		expect(view.needsProjects("tab-a", 1, PROJECTS_RESEND_MS)).toBe(true);
	});

	it("各客户端各记各的", () => {
		const view = createClientView();
		view.setSlim("tab-a", true);
		view.setSlim("tab-b", true);
		expect(view.needsProjects("tab-a", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-b", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-a", 1, 10)).toBe(false);
	});

	it("断开连接后重新连：会重新带一次", () => {
		const view = createClientView();
		view.setSlim("tab-a", true);
		expect(view.needsProjects("tab-a", 1, 0)).toBe(true);
		expect(view.needsProjects("tab-a", 1, 10)).toBe(false);
		view.drop("tab-a");
		view.setSlim("tab-a", true);
		expect(view.needsProjects("tab-a", 1, 20)).toBe(true);
	});

	it("不带 clientId（全局快照 / WS）一律带", () => {
		const view = createClientView();
		expect(view.needsProjects(undefined, 1, 0)).toBe(true);
	});
});

describe("buildSnapshot 的会话清单", () => {
	it("默认带清单", () => {
		const state = createServerState("/w", "fake");
		setPiProjects(state, [project("/r/a", "s1")]);
		expect(buildSnapshot(state).piProjects).toHaveLength(1);
	});

	it("includeProjects: false 时不带（客户端沿用上一份）", () => {
		const state = createServerState("/w", "fake");
		setPiProjects(state, [project("/r/a", "s1")]);
		const snapshot = buildSnapshot(state, undefined, undefined, { includeProjects: false });
		expect(snapshot.piProjects).toBeUndefined();
		expect("piProjects" in snapshot).toBe(false);
	});

	it("换一份清单会推进版本号", () => {
		const state = createServerState("/w", "fake");
		expect(state.piProjectsVersion).toBe(0);
		setPiProjects(state, [project("/r/a", "s1")]);
		setPiProjects(state, [project("/r/a", "s1"), project("/r/b", "s2")]);
		expect(state.piProjectsVersion).toBe(2);
	});
});
