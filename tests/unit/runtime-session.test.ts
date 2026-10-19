/**
 * 会话持久化 / 切换 / 审批规则（M2 + M3）。
 * 共用夹具与 M1 部分共享：helpers/runtime-harness.ts。
 */
import { describe, expect, it } from "vitest";
import type { RuleStore } from "../../server/approval/rules.js";
import { createMemoryRuleStore } from "../../server/approval/rules.js";
import { createFakeEngine } from "../../server/engine/fake.js";
import { createMemorySettingsStore, defaultSettings } from "../../server/session/settings.js";
import { harness, messageTextForTest, waitFor } from "./helpers/runtime-harness.js";

describe("M3：审批规则跨重启（ADR-0006 的「总是允许这类」）", () => {
	it("「总是允许这类」写进规则库，下一次运行不再询问", async () => {
		const rules = createMemoryRuleStore();
		const first = harness(rules);

		const turn = first.runtime.sendMessage("approve please");
		await waitFor(() => first.runtime.snapshot().pendingApproval !== null);
		first.runtime.approve(first.runtime.snapshot().pendingApproval!.requestId, "always");
		await turn;

		const stored = await rules.load();
		expect(stored.map((rule) => rule.scopeKey)).toEqual(["write_file|/Users/me/code/agent-web/docs"]);
		expect(stored[0].scopeHint).toContain("目录");

		// 新的一次运行（新 runtime、同一规则库）→ 同类操作不再弹窗
		const second = harness(rules);
		await second.runtime.init();
		await second.runtime.sendMessage("approve please");
		expect(second.recorder.snapshots.some((snapshot) => snapshot.pendingApproval !== null)).toBe(false);
		expect(messageTextForTest(second.runtime.snapshot())).toContain("审批结果：always");
	});

	it("init 装载规则但不往对话流里塞提示（启动信息只进日志）", async () => {
		const rules = createMemoryRuleStore([{ scopeKey: "bash|npm", scopeHint: "命令 npm", createdAt: 1 }]);
		const { runtime } = harness(rules);
		await runtime.init();
		expect(await rules.load()).toHaveLength(1);
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("审批规则"))).toBe(false);
	});

	it("「允许一次」不写规则（这正是三态的意义）", async () => {
		const rules = createMemoryRuleStore();
		const first = harness(rules);

		const turn = first.runtime.sendMessage("approve please");
		await waitFor(() => first.runtime.snapshot().pendingApproval !== null);
		first.runtime.approve(first.runtime.snapshot().pendingApproval!.requestId, "once");
		await turn;

		expect(await rules.load()).toEqual([]);
	});

	it("规则写盘失败只警告，不阻塞回合（in-memory 规则仍然生效）", async () => {
		const rules: RuleStore = {
			load: async () => [],
			save: async () => {
				throw new Error("磁盘满了");
			},
		};
		const { runtime } = harness(rules);
		const turn = runtime.sendMessage("approve please");
		await waitFor(() => runtime.snapshot().pendingApproval !== null);
		runtime.approve(runtime.snapshot().pendingApproval!.requestId, "always");
		expect((await turn).ok).toBe(true);

		// 第二次同类操作：内存规则已经生效
		await runtime.sendMessage("approve please");
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("写盘失败"))).toBe(true);
	});
});

describe("M3 修：引擎会话的生命周期与历史注入（ADR-0018）", () => {
	it("假引擎忠实复现真引擎：没建会话就发 → engine.no_session", async () => {
		const engine = createFakeEngine({ chunkDelayMs: 0 });
		const events: string[] = [];
		await engine.sendMessage("nope", "hi", (event) => events.push(event.type));
		expect(events).toEqual(["error", "turn_end"]);
	});

	it("同一个会话只建一次引擎会话（不重复扫描资源）", async () => {
		const { runtime, engine } = harness();
		await runtime.sendMessage("第一轮");
		await runtime.sendMessage("第二轮");
		expect(engine.sessions().size).toBe(1);
		expect(engine.sessions().get(runtime.snapshot().active.conversationId!)?.transcript.length).toBeGreaterThan(0);
	});
});

describe("id 必须全局唯一（ADR-0019）", () => {
	it("两个 runtime（模拟两次启动）生成的会话 id 不重复", async () => {
		// 两个 runtime 各自持有一份（真实运行时共享的是 pi 的会话存储，但 id 生成本身必须跨进程唯一）
		const first = harness(createMemoryRuleStore(), { deterministicIds: false });
		await first.runtime.sendMessage("第一次启动");
		const firstId = first.runtime.snapshot().active.conversationId!;

		const second = harness(createMemoryRuleStore(), { deterministicIds: false });
		await second.runtime.init();
		await second.runtime.newConversation();
		const secondId = second.runtime.snapshot().active.conversationId!;

		expect(firstId).not.toBe(secondId);
	});

	it("同一进程内连续两条会话 id 也不同", async () => {
		const { runtime } = harness(createMemoryRuleStore(), { deterministicIds: false });
		await runtime.newConversation();
		const a = runtime.snapshot().active.conversationId!;
		await runtime.newConversation();
		const b = runtime.snapshot().active.conversationId!;
		expect(a).not.toBe(b);
	});
});

describe("M3.5-P1：客户端设置（ADR-0020）", () => {
	it("init 装载设置；applySettings 归一化后写盘并进快照", async () => {
		const store = createMemorySettingsStore({ quickPhrases: ["旧的"], quickPhrasesEnabled: true });
		const { runtime } = harness(createMemoryRuleStore(), { settings: store });
		await runtime.init();
		expect(runtime.snapshot().settings.quickPhrases).toEqual(["旧的"]);

		const result = await runtime.applySettings({
			quickPhrases: ["  继续  ", "重复", "重复", ""],
			quickPhrasesEnabled: false,
		});
		expect(result.ok).toBe(true);
		expect(runtime.snapshot().settings).toEqual({ quickPhrases: ["继续", "重复"], quickPhrasesEnabled: false });
		// 真的落盘了
		expect(await store.load()).toEqual({ quickPhrases: ["继续", "重复"], quickPhrasesEnabled: false });
	});

	it("坏载荷不会把设置弄坏（保持原样）", async () => {
		const store = createMemorySettingsStore({ quickPhrases: ["保留"], quickPhrasesEnabled: true });
		const { runtime } = harness(createMemoryRuleStore(), { settings: store });
		await runtime.init();
		await runtime.applySettings(null);
		expect(runtime.snapshot().settings.quickPhrases).toEqual(["保留"]);
	});

	it("写盘失败只警告，内存里的设置仍然生效", async () => {
		const store = {
			load: async () => defaultSettings(),
			save: async () => {
				throw new Error("磁盘满了");
			},
		};
		const { runtime } = harness(createMemoryRuleStore(), { settings: store });
		await runtime.init();
		await runtime.applySettings({ quickPhrases: ["新的"] });
		expect(runtime.snapshot().settings.quickPhrases).toEqual(["新的"]);
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("保存设置失败"))).toBe(true);
	});

	it("没接设置存储时用默认值（不崩）", async () => {
		const { runtime } = harness();
		await runtime.init();
		expect(runtime.snapshot().settings.quickPhrases.length).toBeGreaterThan(0);
	});
});

describe("M3.5-P2：模型列表与切换（ADR-0020）", () => {
	it("打开/新建会话后能拿到可用模型列表", async () => {
		const { runtime } = harness();
		await runtime.sendMessage("你好");
		await waitFor(() => (runtime.snapshot().models.length ?? 0) > 0);
		expect(runtime.snapshot().models.map((model) => model.id)).toContain("fake/alpha");
	});

	it("切换模型：更新当前模型 + 给出提示", async () => {
		const { runtime, engine } = harness();
		await runtime.sendMessage("你好");
		const result = await runtime.setModel("fake/beta");
		expect(result.ok).toBe(true);
		expect(runtime.snapshot().model).toBe("fake/beta");
		expect(runtime.snapshot().notices.some((notice) => notice.text.includes("已切换模型"))).toBe(true);
		expect(engine.sessions().size).toBeGreaterThan(0);
	});

	it("没有打开的会话时切换被拒（不静默失败）", async () => {
		const { runtime } = harness();
		await runtime.init();
		const result = await runtime.setModel("fake/beta");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("session.none");
	});
});

describe("审批模式提示（替换语义）", () => {
	it("反复切换只留一行，且内容跟着最后状态", async () => {
		const { runtime } = harness(createMemoryRuleStore());
		await runtime.init();
		for (const mode of ["allow", "ask", "allow", "ask"] as const) runtime.setApprovalMode(mode);
		const rows = runtime.snapshot().notices.filter((notice) => notice.key === "approval-mode");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe("审批模式：照旧询问");
	});
});
