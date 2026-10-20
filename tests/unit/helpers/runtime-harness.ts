/**
 * 运行时单测的共用夹具（M1/M2/M3 的测试都从这里取）。
 *
 * 抽出来的原因很实在：护栏要求单测文件 ≤400 行（ADR-0010），而运行时的测试已经超过它。
 * 把「记录 emit / 起 runtime / 等待 / 造消息」这些与用例无关的脚手架集中在这里。
 */
import { createFakeEngine } from "../../../server/engine/fake.js";
import type { MessageBlock, PiProject, ServerEvent, Snapshot } from "../../../server/protocol.js";
import { createMemoryRuleStore, type RuleStore } from "../../../server/approval/rules.js";
import type { SettingsStore } from "../../../server/session/settings.js";
import { createRuntime, type Runtime } from "../../../server/session/runtime.js";

/** 记录 emit 的快照与事件，便于断言「推了什么、什么时候推」 */
export function recorder() {
	const snapshots: Snapshot[] = [];
	const events: ServerEvent[] = [];
	return {
		emit: {
			snapshot: (snapshot: Snapshot) => snapshots.push(snapshot),
			event: (event: ServerEvent) => events.push(event),
		},
		snapshots,
		events,
		latest: () => snapshots[snapshots.length - 1],
		reset: () => {
			snapshots.length = 0;
			events.length = 0;
		},
	};
}

export function harness(
	rules: RuleStore = createMemoryRuleStore(),
	options: {
		deterministicIds?: boolean;
		settings?: SettingsStore;
		/** 会话列表来源（ADR-0021 §2 起是唯一来源）：默认空列表 */
		piSessions?: () => Promise<PiProject[]>;
		/** provider 列表来源（模型面板）：默认空列表 */
		loadProviders?: () => Promise<import("../../../server/protocol.js").ProviderView[]>;
	} = {},
): {
	runtime: Runtime;
	recorder: ReturnType<typeof recorder>;
	rules: RuleStore;
	/** 假引擎本体：用来断言「宿主把什么交给了引擎」（会话、历史） */
	engine: ReturnType<typeof createFakeEngine>;
} {
	const recorderInstance = recorder();
	let seq = 0;
	const engine = createFakeEngine({ chunkDelayMs: 0, slowChunkDelayMs: 5 });
	const runtime = createRuntime({
		engine,
		rules,
		...(options.settings ? { settings: options.settings } : {}),
		...(options.piSessions ? { piSessions: options.piSessions } : { piSessions: async () => [] }),
		...((options.loadProviders ?? (async () => []))
			? { loadProviders: options.loadProviders ?? (async () => []) }
			: {}),
		workspace: "/tmp/agent-web-test",
		emit: recorderInstance.emit,
		// 默认确定性 id（用例好断言）；显式关掉时用真实运行的全局唯一 id（ADR-0019）
		...(options.deterministicIds === false ? {} : { idSeq: (prefix: string) => `${prefix}-${++seq}` }),
	});
	return { runtime, recorder: recorderInstance, rules, engine };
}

export const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("等待超时");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

/** 一条快照里所有助手文本（断言「模型说了什么」用） */
export const assistantText = (snapshot: Snapshot) =>
	snapshot.active.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.blocks)
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("");

export function createMessageForTest(id: string, role: "user" | "assistant", ts: number) {
	return { id, role, ts, blocks: [] as MessageBlock[] };
}

export function appendTextForTest(
	message: { id: string; role: "user" | "assistant"; ts: number; blocks: MessageBlock[] },
	text: string,
) {
	return { ...message, blocks: [...message.blocks, { kind: "text" as const, text }] };
}

/** 快照里所有文本（不分角色） */
export function messageTextForTest(snapshot: Snapshot): string {
	return snapshot.active.messages
		.flatMap((message) => message.blocks)
		.map((block) => (block.kind === "text" ? block.text : ""))
		.join("");
}
