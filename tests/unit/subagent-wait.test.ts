/**
 * `waitForRun` 的「先查再订阅」竞态（`server/engine/pi-subagent-tool.ts`）。
 *
 * 子代理运行状态是**推**出来的（`port.subscribe` 只推后续变化，不回放当前状态），
 * 所以「先 get() 看一眼 → 再 subscribe()」之间存在一个窗口：
 * 如果运行恰好在这两步之间结束，那个终态事件就永远收不到。
 *
 * 原来的后果：Agent 工具会一直等到 timeoutMs（默认 40 分钟）才回一句「一直没有结束」，
 * 而父回合在这 40 分钟里一直显示「进行中」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentEnginePort } from "../../server/engine/port.ts";
import { waitForRun } from "../../server/engine/pi-subagent-tool.ts";
import type { SubagentRunView } from "../../web/src/types.ts";

const view = (status: SubagentRunView["status"]): SubagentRunView =>
	({ id: "run-1", conversationId: "c1", profile: "explore", status, task: "t" }) as SubagentRunView;

/** 只在 `get` 的**第二次**调用（即订阅后的补查）返回终态，模拟「窗口内结束」 */
const racingPort = (): { port: SubagentEnginePort; subscribed: boolean } => {
	let gets = 0;
	const state = { subscribed: false };
	const port = {
		get() {
			gets += 1;
			return gets === 1 ? view("running") : view("completed");
		},
		subscribe() {
			state.subscribed = true;
			return () => {};
		},
	} as unknown as SubagentEnginePort;
	return {
		port,
		get subscribed() {
			return state.subscribed;
		},
	} as { port: SubagentEnginePort; subscribed: boolean };
};

test("终态落在 get 与 subscribe 之间：补查能救回来，不用等到超时", async () => {
	const { port } = racingPort();
	const started = Date.now();
	const run = await waitForRun(port, "run-1", 30_000);
	assert.equal(run?.status, "completed", "应该拿到终态，而不是 null（超时）");
	assert.ok(Date.now() - started < 1000, "必须是立刻返回，不能等 timeout");
});

test("已经结束的运行：一进门就返回，不订阅", async () => {
	let subscribed = false;
	const port = {
		get: () => view("completed"),
		subscribe: () => {
			subscribed = true;
			return () => {};
		},
	} as unknown as SubagentEnginePort;
	assert.equal((await waitForRun(port, "run-1", 30_000))?.status, "completed");
	assert.equal(subscribed, false);
});

test("订阅推送的终态同样能收敛（正常路径没被改动破坏）", async () => {
	let listener: ((run: SubagentRunView) => void) | null = null;
	const port = {
		get: () => view("running"),
		subscribe: (fn: (run: SubagentRunView) => void) => {
			listener = fn;
			return () => {};
		},
	} as unknown as SubagentEnginePort;
	const pending = waitForRun(port, "run-1", 30_000);
	listener?.(view("running"));
	listener?.(view("failed"));
	assert.equal((await pending)?.status, "failed");
});
