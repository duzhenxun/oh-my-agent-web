/**
 * 打断探针（一次性、只在开发时跑）：验证「插队 = 打断续发」这条路在四个引擎上到底成不成立。
 *
 * 要回答的三个问题（ADR-0054 的证据来源）：
 *   1. 工具正在跑的时候打断：多久 settle？正在跑的工具是被掐掉还是跑完？（决定插队会不会毁掉写了一半的操作）
 *   2. settle 之后能不能**立刻**再发下一条（同步竞态）？
 *   3. 一轮还在跑的时候再发一条会怎样？（报错 / 静默排队 / 覆盖 adapter 的 active 槽）
 *
 * 用法：node --import tsx scripts/probe-interrupt.mts codex|dsh|opencode|claude
 * 报告写 /tmp/aw-probe-<engine>.json —— 别指望终端，tail 会把关键字段截掉。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeEngine } from "../server/engine/claude.js";
import { createCodexEngine } from "../server/engine/codex.js";
import { createDshEngine } from "../server/engine/dsh.js";
import { createOpencodeEngine } from "../server/engine/opencode.js";
import type { EngineEvent, EnginePort } from "../server/engine/port.js";

const engineName = (process.argv[2] ?? "").trim();
if (!["codex", "dsh", "opencode", "claude"].includes(engineName)) {
	console.error("用法：node --import tsx scripts/probe-interrupt.mts codex|dsh|opencode|claude");
	process.exit(2);
}

const t0 = Date.now();
const mark = (): number => Date.now() - t0;
const log = (text: string): void => console.log(`[${String(mark()).padStart(6)}ms] ${text}`);

/** 第一轮：跑一条睡 15 秒的命令 —— 让我们有一段「工具正在跑」的窗口可以打断 */
const LONG_PROMPT = "用 bash 工具执行 `sleep 15`，跑完只回复 OK 两个字母。不要做别的事。";
/** 收尾轮：验证 settle 之后会话还能不能正常用 */
const SHORT_PROMPT = "只回复 OK，不要用任何工具。";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	try {
		return await Promise.race([promise, timed]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const engine: EnginePort =
	engineName === "codex"
		? createCodexEngine({ log: (text) => log(`  codex> ${text}`) })
		: engineName === "dsh"
			? createDshEngine({ log: (text) => log(`  dsh> ${text}`) })
			: engineName === "opencode"
				? createOpencodeEngine({ log: (text) => log(`  opencode> ${text}`) })
				: createClaudeEngine({ log: (text) => log(`  claude> ${text}`) });

// 探针里一律自动放行：否则 sleep 那条命令卡在审批上，测出来的就不是打断了
engine.setApprovalHandler?.(async (request) => {
	log(`  审批：${request.toolName} → once`);
	return "once";
});

const report: Record<string, unknown> = { engine: engineName };
const timeline: string[] = [];
const cwd = await mkdtemp(join(tmpdir(), `aw-probe-${engineName}-`));
const sessionId = `probe-${engineName}-${Date.now()}`;

let sawToolStart = false;
let sawToolEnd = false;
const push =
	(tag: string) =>
	(event: EngineEvent): void => {
		if (event.type === "text_delta" || event.type === "thinking_delta") return;
		const label =
			event.type === "turn_end"
				? `turn_end(${event.reason})`
				: event.type === "tool_end"
					? `tool_end(${event.status})`
					: event.type;
		if (event.type === "tool_start") sawToolStart = true;
		if (event.type === "tool_end") sawToolEnd = true;
		timeline.push(`${mark()}ms [${tag}] ${label}`);
	};

try {
	log("建立会话");
	const created = await withTimeout(engine.createSession({ sessionId, workspace: cwd }), 90_000);
	if (created === "timeout") {
		report.createSession = "timeout(90s)";
		throw new Error("建会话超时");
	}
	log(`会话就绪 ${created.engineSessionId ?? "-"}`);

	// ================= 阶段 A：工具正在跑的时候打断 =================
	const firstSettled = { value: false, at: 0, error: null as string | null };
	const first = engine.sendMessage(sessionId, LONG_PROMPT, push("A"));
	void first.then(
		() => {
			firstSettled.value = true;
			firstSettled.at = mark();
		},
		(error: unknown) => {
			firstSettled.value = true;
			firstSettled.at = mark();
			firstSettled.error = error instanceof Error ? error.message : String(error);
		},
	);

	const waitStart = Date.now();
	while (!sawToolStart && !firstSettled.value && Date.now() - waitStart < 60_000) await sleep(50);
	report.toolStarted = sawToolStart;
	log(`工具已开始：${sawToolStart}（${mark()}ms）`);

	// 让命令真的跑起来 1.5s 再打断（模拟用户看到工具在跑时点插队）
	await sleep(1500);
	const tInt = mark();
	log("打断");
	await engine.interrupt(sessionId).catch((error: unknown) => log(`  interrupt 抛错：${String(error)}`));

	const settledIn = await withTimeout(
		(async () => {
			while (!firstSettled.value) await sleep(20);
			return mark() - tInt;
		})(),
		20_000,
	);
	report.interruptDuringTool = {
		settleMs: settledIn === "timeout" ? "timeout(20s 未 settle)" : settledIn,
		firstError: firstSettled.error,
		/** 打断这一刻工具还在跑，之后它有没有正常收尾 */
		toolEndedAfterInterrupt: sawToolEnd,
	};
	log(`打断 → settle：${JSON.stringify(settledIn)}，工具收尾=${sawToolEnd}`);

	// 再等 3s：看被「打断」的工具是不是还会回来（掐掉 vs 跑完）
	await sleep(3000);
	report.toolAfter3s = sawToolEnd;

	// ================= 阶段 B：settle 之后立刻再发 =================
	const tAfter = mark();
	const after = await withTimeout(engine.sendMessage(sessionId, SHORT_PROMPT, push("B")), 90_000).catch(
		(error: unknown) => `throw: ${error instanceof Error ? error.message : String(error)}`,
	);
	report.sendAfterInterrupt = {
		elapsedMs: mark() - tAfter,
		result: after === "timeout" ? "timeout(90s 未返回)" : (after ?? "resolved"),
	};
	log(`打断后再发：${JSON.stringify(report.sendAfterInterrupt)}`);

	// ================= 阶段 C：一轮在飞时再发一条 =================
	const long2 = engine.sendMessage(sessionId, LONG_PROMPT, push("C1"));
	void long2.catch(() => undefined);
	let sawAgain = false;
	const waitAgain = Date.now();
	while (!sawToolStart || (sawToolStart && !sawAgain) ) {
		if (Date.now() - waitAgain > 60_000) break;
		// 等到这一轮的 tool_start（时间线里 C1 的 tool_start）
		if (timeline.some((line) => line.includes("[C1] tool_start"))) sawAgain = true;
		else await sleep(50);
	}
	const doubled = await withTimeout(engine.sendMessage(sessionId, SHORT_PROMPT, push("C2")), 8_000).catch(
		(error: unknown) => `throw: ${error instanceof Error ? error.message : String(error)}`,
	);
	report.sendWhileBusy = {
		waitedForToolStart: sawAgain,
		result: doubled === "timeout" ? "timeout(8s 未返回 → adapter 的 active 槽被覆盖)" : (doubled ?? "resolved"),
	};
	log(`在飞再发一条：${JSON.stringify(report.sendWhileBusy)}`);

	// 收掉这一轮，别让它在后台继续烧 token
	await engine.interrupt(sessionId).catch(() => undefined);
	await sleep(1000);
} catch (error) {
	report.fatal = error instanceof Error ? error.message : String(error);
	log(`失败：${report.fatal}`);
} finally {
	report.timeline = timeline;
	report.wallClockMs = mark();
	await engine.closeSession?.(sessionId).catch(() => undefined);
	await engine.dispose?.();
	await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
	const file = `/tmp/aw-probe-${engineName}.json`;
	await writeFile(file, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
	console.log(`\n===== ${engineName} → ${file} =====`);
	console.log(JSON.stringify({ ...report, timeline: undefined }, null, 2));
	process.exit(0);
}
