/**
 * 插队的 interrupt 档：**真引擎 + 真队列**的接缝测试（ADR-0054）。
 *
 * 单元测试（tests/unit/steer-interrupt.test.ts）验证队列的判断逻辑；这里验证的是
 * 「打断之后那条消息真的能发出去」，用的是本机真实的引擎 CLI：
 *
 *   1. 起一轮真的会跑很久的回合（bash sleep），确认工具已经开跑；
 *   2. 像界面那样 `busy("steer", ...)` 入队 → `flushSteer` → 适配器真的打断；
 *   3. 在飞时再发一条必须**被自己拦住**（不许覆盖引擎的 active 槽）；
 *   4. 模拟回合收尾的排空（`shiftSteerFirst`）—— 取出来的必须是**插队那条**；
 *   5. 把它当新一轮发出去必须成功（说明真的落定了），并带上 `steer` 标记。
 *
 * 表驱动：每接一家新引擎就往 ENGINES 里加一行，同一套断言自动覆盖。
 * 本机没装那个 CLI 就跳过 —— 这测的不是纯逻辑，硬跑一个不存在的可执行文件只是噪音。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCodexEngine } from "../../server/engine/codex.ts";
import { createClaudeEngine } from "../../server/engine/claude.ts";
import { createDshEngine } from "../../server/engine/dsh.ts";
import { createOpencodeEngine } from "../../server/engine/opencode.ts";
import type { EngineEvent, EnginePort } from "../../server/engine/port.ts";
import { createTurnPlumbing, type QueuedView } from "../../server/session/turn-queue.ts";

function hasCli(bin: string): boolean {
	try {
		execFileSync(bin, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Case = { name: string; bin: string; create: () => EnginePort };

const ENGINES: Case[] = [
	{ name: "codex", bin: "codex", create: () => createCodexEngine({ log: () => {} }) },
	{ name: "opencode", bin: "opencode", create: () => createOpencodeEngine({ log: () => {} }) },
	{ name: "dsh", bin: "dsh", create: () => createDshEngine({ log: () => {} }) },
	{ name: "claude", bin: "claude", create: () => createClaudeEngine({ log: () => {} }) },
];

for (const engineCase of ENGINES) {
	test(
		`真 ${engineCase.name}：插队 → 打断当前轮 → 那条消息被当下一轮发出去（带 steer 标记）`,
		{ skip: !hasCli(engineCase.bin) ? `本机没有 ${engineCase.bin} CLI` : false, timeout: 240_000 },
		async () => {
			const engine = engineCase.create();
			engine.setApprovalHandler?.(async () => "once");
			const cwd = await mkdtemp(join(tmpdir(), `aw-steer-it-${engineCase.name}-`));
			const conversationId = `it-${engineCase.name}-${Date.now()}`;

			const state: { activeId: string | null; queued: QueuedView[] } = { activeId: conversationId, queued: [] };
			const notices: { text: string; level: string }[] = [];
			const appended: { text: string; steer?: boolean }[] = [];
			const steerMarks: string[] = [];
			let running = false;
			let toolStarted = false;

			const plumbing = createTurnPlumbing({
				state,
				engine,
				nextId: (prefix) => `${prefix}-${Math.random()}`,
				appendUser: (_id, text, steer) => appended.push({ text, steer }),
				notice: (text, level) => notices.push({ text, level }),
				pushSnapshot: () => {},
				isTurnRunning: () => running,
				steerMode: () => "interrupt",
				supportsSteer: () => true,
				interruptAndSettle: (id) => engine.interruptAndSettle!(id),
				interrupt: (id) => engine.interrupt(id),
				onInterruptForSteer: (id) => steerMarks.push(id),
			});

			try {
				await engine.createSession({ sessionId: conversationId, workspace: cwd });

				// ---- 守卫：在飞时再发一条，必须被拦住（不许覆盖 active 槽）----
				running = true;
				const first = engine.sendMessage(conversationId, "用 bash 执行 `sleep 20`，跑完只回复 OK。", (event: EngineEvent) => {
					if (event.type === "tool_start") toolStarted = true;
				});
				void first.catch(() => undefined);

				const waitStart = Date.now();
				while (!toolStarted && Date.now() - waitStart < 90_000) {
					// 先等工具开跑；等到了再测守卫，否则第二轮可能落在「还没开始」的空窗
					if (!toolStarted) await sleep(50);
				}
				assert.ok(toolStarted, "第一轮应该已经开跑（否则这个测试测不到打断）");

				const guard = await engine
					.sendMessage(conversationId, "插一句", () => {})
					.then(() => "resolved")
					.catch((error: unknown) => `throw: ${error instanceof Error ? error.message : String(error)}`);
				assert.match(String(guard), /throw:.*回合在跑/, `在飞时再发必须自己拦住（实际：${guard}）`);

				// ---- 插队 ----
				await plumbing.busy("steer", "先别跑了，只回复 OK", "先别跑了，只回复 OK", undefined, conversationId);
				assert.equal(state.queued[0]?.mode, "steer", "插队项应挂在队列里");
				// 越过最小撤回窗口（真实时间是 1.2 秒，测试里把「现在」直接推过去）
				const realNow = Date.now;
				Date.now = () => realNow() + 5000;
				try {
					plumbing.flushSteer(conversationId);
				} finally {
					Date.now = realNow;
				}

				// 等打断真的落定
				const settleWait = Date.now();
				while (running && Date.now() - settleWait < 30_000) await sleep(50);
				assert.ok(steerMarks.includes(conversationId), "打断之前必须打上「插队造成的」标记");
				assert.ok(
					notices.some((item) => /已插队/.test(item.text)),
					"用户要看到「已插队」这句话",
				);
				assert.equal(appended.length, 0, "interrupt 档不能在打断时自己写对话记录（交给排空那条路径）");

				// ---- 回合收尾的排空：必须取出插队那条 ----
				running = false;
				const next = plumbing.queue.shiftSteerFirst(conversationId);
				assert.equal(next?.text, "先别跑了，只回复 OK");
				assert.equal(next?.mode, "steer");

				// ---- 当新一轮发出去：要能成功 ----
				const results: string[] = [];
				await engine
					.sendMessage(conversationId, next!.text, () => {})
					.then(() => results.push("resolved"))
					.catch((error: unknown) => results.push(`throw: ${error instanceof Error ? error.message : String(error)}`));
				assert.deepEqual(results, ["resolved"], "打断落定后必须能立刻发下一条");
			} finally {
				await engine.closeSession?.(conversationId).catch(() => undefined);
				await engine.dispose?.();
				await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
			}
		},
	);
}
