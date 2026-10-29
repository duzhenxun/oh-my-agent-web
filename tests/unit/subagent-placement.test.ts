/**
 * 子代理卡片挂在对话流的哪个位置（`web/src/subagent-view.tsx`）。
 *
 * 契约（用户提的展示要求，别改回去）：
 *   1. 卡片内嵌在**当轮那条助手消息**里（过程之后、正文之前），不是吊在对话下面；
 *   2. 后一轮再派子代理时**新长一块**，不能把上一轮那块挪过来 / 顶掉 —— 旧卡片留在原位当历史；
 *   3. 发新消息之后，顶栏徽标只认新一轮（上一问的子代理退场）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assignRunsToMessages,
	runsOfCurrentTurn,
	subagentUsageOf,
	turnStartedAtOf,
} from "../../web/src/subagent-view.tsx";
import type { SubagentRunView } from "../../web/src/types.ts";

const run = (id: string, startedAt: number): SubagentRunView =>
	({
		id,
		conversationId: "c1",
		profile: "explore",
		label: "Explore",
		description: id,
		status: "completed",
		task: "t",
		startedAt,
	}) as SubagentRunView;

describe("assignRunsToMessages", () => {
	const messages = [
		{ id: "u1", role: "user", ts: 1000 },
		{ id: "a1", role: "assistant", ts: 1000 },
		{ id: "u2", role: "user", ts: 5000 },
		{ id: "a2", role: "assistant", ts: 5000 },
	];

	it("第一轮的运行归 a1，第二轮归 a2（各自一块，互不挪动）", () => {
		const assigned = assignRunsToMessages([run("r1", 1200), run("r2", 5300)], messages);
		assert.deepEqual(
			assigned.get("a1")?.map((item) => item.id),
			["r1"],
		);
		assert.deepEqual(
			assigned.get("a2")?.map((item) => item.id),
			["r2"],
		);
	});

	it("一轮里多个子代理都归同一条消息（同批派发）", () => {
		const assigned = assignRunsToMessages([run("r1", 1100), run("r2", 1150), run("r3", 1300)], messages);
		assert.equal(assigned.get("a1")?.length, 3);
		assert.equal(assigned.get("a2"), undefined);
	});

	it("第二轮**不会**把第一轮那条挤掉：a1 的卡片还在（历史保留）", () => {
		const round1 = [run("r1", 1200)];
		const round2 = [...round1, run("r9", 5400)];
		const assigned = assignRunsToMessages(round2, messages);
		assert.deepEqual(
			assigned.get("a1")?.map((item) => item.id),
			["r1"],
		);
		assert.deepEqual(
			assigned.get("a2")?.map((item) => item.id),
			["r9"],
		);
	});

	it("早于所有消息的运行不挂到任何消息上（不凭空出现在第一条下面）", () => {
		const assigned = assignRunsToMessages([run("old", 10)], messages);
		assert.equal(assigned.size, 0);
	});

	it("没有助手消息（或时间戳非法）→ 不渲染", () => {
		const assigned = assignRunsToMessages(
			[run("r1", 1200)],
			[
				{ id: "u1", role: "user", ts: 1000 },
				{ id: "a1", role: "assistant", ts: Number.NaN },
			],
		);
		assert.equal(assigned.size, 0);
	});

	it("一条运行只会出现在一条消息上（不重复渲染）", () => {
		const assigned = assignRunsToMessages([run("r1", 5200)], messages);
		const total = [...assigned.values()].reduce((sum, list) => sum + list.length, 0);
		assert.equal(total, 1);
	});

	it("助手消息时间戳晚于子代理开始（重开历史会话后）→ 仍挂在本轮那条消息上，不下沉到上一轮", () => {
		// 历史会话里助手 ts 是整条消息的**完成时间**（3000），子代理却在 1200 就开了
		const rebuilt = [
			{ id: "u0", role: "user", ts: 500 },
			{ id: "a0", role: "assistant", ts: 600 },
			{ id: "u1", role: "user", ts: 1000 },
			{ id: "a1", role: "assistant", ts: 3000 },
		];
		const assigned = assignRunsToMessages([run("r1", 1200), run("r2", 1500)], rebuilt);
		assert.deepEqual(
			assigned.get("a1")?.map((item) => item.id),
			["r1", "r2"],
		);
		assert.equal(assigned.get("a0"), undefined);
	});

	it("一轮里拆成多条助手消息 → 卡片落在本轮最后一条（位置不来回跳）", () => {
		const split = [
			{ id: "u1", role: "user", ts: 1000 },
			{ id: "a1", role: "assistant", ts: 1100 },
			{ id: "a2", role: "assistant", ts: 1200 },
		];
		const assigned = assignRunsToMessages([run("r1", 1150)], split);
		assert.deepEqual(
			assigned.get("a2")?.map((item) => item.id),
			["r1"],
		);
		assert.equal(assigned.get("a1"), undefined);
	});

	it("本轮已跑完的运行不会因为下一条用户消息出现而消失（历史卡片留在原位）", () => {
		const next = [...messages, { id: "u3", role: "user", ts: 9000 }];
		const assigned = assignRunsToMessages([run("r1", 1200)], next);
		assert.deepEqual(
			assigned.get("a1")?.map((item) => item.id),
			["r1"],
		);
	});
});

describe("turnStartedAtOf / runsOfCurrentTurn", () => {
	const messages = [
		{ role: "system", ts: 10 },
		{ role: "user", ts: 100 },
		{ role: "assistant", ts: 100 },
		{ role: "user", ts: 900 },
		{ role: "assistant", ts: 900 },
	];

	it("本轮起点取最后一条用户消息（不是第一条）", () => {
		assert.equal(turnStartedAtOf(messages), 900);
	});

	it("没有用户消息 → null（不显示任何子代理）", () => {
		assert.equal(turnStartedAtOf([{ role: "assistant", ts: 5 }]), null);
	});

	it("只留本轮开始的运行：上一问的子代理退场", () => {
		const runs = [run("old", 150), run("new", 950)];
		const current = runsOfCurrentTurn(runs, 900);
		assert.deepEqual(
			current.map((item) => item.id),
			["new"],
		);
	});

	it("turnStartedAt 为 null → 空（刷新后还没有用户消息）", () => {
		assert.deepEqual(runsOfCurrentTurn([run("r1", 1)], null), []);
	});
});

describe("subagentUsageOf（尾注里那一块）", () => {
	it("把本轮子代理的 tokens / 花费加总", () => {
		const usage = subagentUsageOf([
			{ ...run("r1", 1200), tokens: { input: 1000, output: 200, total: 1200 }, cost: 0.01 } as SubagentRunView,
			{ ...run("r2", 1300), tokens: { input: 4000, output: 800, total: 4800 }, cost: 0.05 } as SubagentRunView,
		]);
		// 花费是浮点累加（0.01 + 0.05），按容差比
		assert.equal(usage.count, 2);
		assert.equal(usage.input, 5000);
		assert.equal(usage.output, 1000);
		assert.equal(usage.total, 6000);
		assert.ok(Math.abs(usage.cost - 0.06) < 1e-9, `cost=${usage.cost}`);
	});

	it("还没回报用量（tokens 缺省）→ 只有 count，数值是 0", () => {
		const usage = subagentUsageOf([run("r1", 1200)]);
		assert.deepEqual(usage, { count: 1, input: 0, output: 0, total: 0, cost: 0 });
	});

	it("没有子代理 → 全 0（UI 据此不渲染那一段）", () => {
		assert.deepEqual(subagentUsageOf([]), { count: 0, input: 0, output: 0, total: 0, cost: 0 });
	});
});
