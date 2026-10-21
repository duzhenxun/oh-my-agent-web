/**
 * 切会话（ADR-0021 §2 / ADR-0033）：谁负责「记下在看哪」、什么时候必须推快照。
 *
 * 重点守两条回归：
 *   1. 点到**已经是当前**的会话（或别的标签页已经切过去），也必须推一份快照 ——
 *      客户端靠它把乐观高亮退掉，否则点一下当前会话就永远停在「正在打开…」；
 *   2. pi 历史会话第一次打开要走 open()，并把文件根切到它自己的目录。
 */
import { describe, expect, it } from "vitest";
import type { PiProject, UiMessage } from "../../server/protocol.js";
import type { ServerState } from "../../server/snapshot/state.js";
import { createClientView } from "../../server/session/client-view.js";
import { createSwitchConversation } from "../../server/session/switch-conversation.js";

type Counters = {
	pushes: number;
	opens: string[];
	refreshes: string[];
	reports: string[];
	models: string[];
	thinking: string[];
	stats: number;
};

function makeDeps(options: {
	activeId?: string | null;
	ownConversations?: { id: string; workspace: string }[];
	piSessions?: Record<string, { title: string; workspace: string }>;
	messages?: Record<string, UiMessage[]>;
	openResult?: UiMessage[] | null;
}) {
	const counters: Counters = { pushes: 0, opens: [], refreshes: [], reports: [], models: [], thinking: [], stats: 0 };
	const state = {
		activeId: options.activeId ?? null,
		messages: options.messages ?? {},
		files: { root: "/old/root", treeVersion: 1 },
		conversations: (options.ownConversations ?? []).map((item) => ({
			id: item.id,
			title: "t",
			workspace: item.workspace,
			createdAt: 0,
			updatedAt: 0,
			messageCount: 0,
		})),
		piProjects: [] as PiProject[],
	} as unknown as ServerState;
	const clientView = createClientView();
	const switchTo = createSwitchConversation({
		state,
		clientView,
		infoOf: (id) => options.piSessions?.[id] ?? null,
		open: async (id) => {
			counters.opens.push(id);
			return options.openResult === undefined ? [{ id: "m1", role: "user", ts: 0, blocks: [] }] : options.openResult;
		},
		refreshSessions: async (force) => {
			counters.refreshes.push(String(force));
		},
		refreshModels: async (id) => {
			counters.models.push(id);
		},
		refreshThinking: async (id) => {
			counters.thinking.push(id);
		},
		refreshStats: () => {
			counters.stats += 1;
		},
		report: (text) => counters.reports.push(text),
		pushSnapshot: () => {
			counters.pushes += 1;
		},
	});
	return { switchTo, counters, state, clientView };
}

describe("switchConversation", () => {
	it("切到自己的会话：更新 activeId / 文件根，并推快照", async () => {
		const { switchTo, counters, state } = makeDeps({
			activeId: "conv-a",
			ownConversations: [
				{ id: "conv-a", workspace: "/repo/a" },
				{ id: "conv-b", workspace: "/repo/b" },
			],
		});
		expect(await switchTo("conv-b", "tab-1")).toEqual({ ok: true });
		expect(state.activeId).toBe("conv-b");
		expect(state.files?.root).toBe("/repo/b");
		expect(counters.pushes).toBe(1);
	});

	it("点到的就是当前会话：也要推一份快照（客户端靠它退掉乐观高亮）", async () => {
		const { switchTo, counters, state } = makeDeps({
			activeId: "conv-a",
			ownConversations: [{ id: "conv-a", workspace: "/repo/a" }],
		});
		expect(await switchTo("conv-a", "tab-1")).toEqual({ ok: true });
		expect(state.activeId).toBe("conv-a");
		expect(counters.pushes).toBe(1);
	});

	it("pi 历史会话第一次打开：走 open()，记下每个客户端在看哪", async () => {
		const { switchTo, counters, state, clientView } = makeDeps({
			activeId: null,
			piSessions: { "pi-1": { title: "历史", workspace: "/repo/pi" } },
		});
		expect(await switchTo("pi-1", "tab-1")).toEqual({ ok: true });
		expect(counters.opens).toEqual(["pi-1"]);
		expect(state.messages["pi-1"]).toHaveLength(1);
		expect(state.activeId).toBe("pi-1");
		expect(state.files?.root).toBe("/repo/pi");
		expect(clientView.activeFor("tab-1", null)).toBe("pi-1");
		expect(counters.pushes).toBe(1);
		expect(counters.models).toEqual(["pi-1"]);
		expect(counters.thinking).toEqual(["pi-1"]);
	});

	it("pi 会话：切过去再切回来，不会重复读文件（已经是当前会话就不再 open）", async () => {
		const { switchTo, counters, state } = makeDeps({
			activeId: null,
			piSessions: { "pi-1": { title: "历史", workspace: "/repo/pi" } },
		});
		expect(await switchTo("pi-1", "tab-1")).toEqual({ ok: true });
		expect(counters.opens).toEqual(["pi-1"]);
		// 再点一次同一条：activeId 已经就是它，不应该再去读一遍
		expect(await switchTo("pi-1", "tab-1")).toEqual({ ok: true });
		expect(counters.opens).toEqual(["pi-1"]);
		expect(state.activeId).toBe("pi-1");
	});

	it("打开失败：回 session.open_failed，不改 activeId", async () => {
		const { switchTo, counters, state } = makeDeps({
			activeId: null,
			piSessions: { "pi-1": { title: "历史", workspace: "/repo/pi" } },
			openResult: null,
		});
		const result = await switchTo("pi-1", "tab-1");
		expect(result).toEqual({ ok: false, error: { code: "session.open_failed", message: "打开会话失败：pi-1" } });
		expect(state.activeId).toBe(null);
		expect(counters.pushes).toBe(0);
	});

	it("会话不存在：回 session.not_found", async () => {
		const { switchTo, counters } = makeDeps({ activeId: null });
		const result = await switchTo("nope", "tab-1");
		expect(result.ok).toBe(false);
		expect(counters.pushes).toBe(0);
	});
});
